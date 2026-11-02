import type Database from "better-sqlite3";
import { audit } from "../audit.js";
import { IMPORTANCE_RANK, type Importance, type WorkerConfig } from "../config.js";
import { etClock, etDayBounds } from "../marketdata/time.js";
import { silentLogger, type Logger } from "../log.js";
import { finishAiCall, payloadHash, reserveAiCall, sanitizeAnalysis, type AnalysisProvider, type AnalysisRequest } from "./ai.js";
import { escapeHtml, sendTelegram, type FetchLike, type TelegramTarget } from "./telegram.js";

export type AlertSpec = {
  type: string;
  symbol: string | null;
  importance: Importance;
  /** Identity of "the same thing happening again"; repeats inside cooldownMs are dropped. */
  dedupeKey: string;
  cooldownMs: number;
  title: string;
  body: string;
  /** Honest description of the data behind this alert, e.g. "delayed · 42s old · nasdaq". */
  dataLabel?: string | null;
  payload?: Record<string, unknown>;
};

export type AlertContext = {
  db: Database.Database;
  nowMs: number;
  cfg: Pick<WorkerConfig, "alertDailyCap" | "telegram">;
};

export type RaiseResult = { alertId: number } | { suppressed: "cooldown" | "daily_cap" };

/**
 * The single entry point for creating an alert. Enforces, in order:
 *   1. persistent de-duplication (survives restarts, because it reads the events table)
 *   2. a daily cap (high-importance alerts get double headroom, never unlimited)
 * and records the decision in the audit log either way.
 */
export function raiseAlert(ctx: AlertContext, spec: AlertSpec): RaiseResult {
  const { db, nowMs } = ctx;
  const tx = db.transaction((): RaiseResult => {
    const dup = db.prepare("SELECT 1 FROM events WHERE dedupe_key = ? AND created_at > ? LIMIT 1").get(spec.dedupeKey, nowMs - spec.cooldownMs);
    if (dup) return { suppressed: "cooldown" };

    const bounds = etDayBounds(etClock(nowMs).dateKey)!;
    const today = (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE created_at >= ? AND created_at < ?").get(bounds.startMs, bounds.endMs) as { c: number }).c;
    const cap = spec.importance === "high" ? ctx.cfg.alertDailyCap * 2 : ctx.cfg.alertDailyCap;
    if (today >= cap) return { suppressed: "daily_cap" };

    const eventId = Number(
      db
        .prepare("INSERT INTO events (created_at, symbol, type, importance, dedupe_key, payload) VALUES (?, ?, ?, ?, ?, ?)")
        .run(nowMs, spec.symbol, spec.type, spec.importance, spec.dedupeKey, JSON.stringify(spec.payload ?? {})).lastInsertRowid
    );
    const wantsTelegram = ctx.cfg.telegram.enabled && IMPORTANCE_RANK[spec.importance] >= IMPORTANCE_RANK[ctx.cfg.telegram.minImportance];
    const alertId = Number(
      db
        .prepare(
          `INSERT INTO alerts (created_at, event_id, symbol, type, importance, title, body, data_label, telegram_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(nowMs, eventId, spec.symbol, spec.type, spec.importance, spec.title, spec.body, spec.dataLabel ?? null, wantsTelegram ? "pending" : "none").lastInsertRowid
    );
    return { alertId };
  });
  const r = tx.immediate();
  if ("alertId" in r) {
    audit(db, { kind: "alert", symbol: spec.symbol, decision: "emitted", reason: spec.type, detail: { alertId: r.alertId, importance: spec.importance } }, nowMs);
  } else {
    audit(db, { kind: "alert", symbol: spec.symbol, decision: "suppressed", reason: r.suppressed, detail: { type: spec.type, key: spec.dedupeKey } }, nowMs);
  }
  return r;
}

// ---- AI enrichment ----

export type AiContext = AlertContext & {
  provider: AnalysisProvider | null;
  cfg: Pick<WorkerConfig, "alertDailyCap" | "telegram" | "ai">;
  log?: Logger;
};

/**
 * Event-triggered analysis: called only for a specific, already-detected alert,
 * never for quote updates. Gated by importance, a daily call budget, a minimum
 * spacing, and duplicate-payload suppression. Failures degrade to "no analysis";
 * they never block or alter the alert itself.
 */
export async function enrichWithAi(ctx: AiContext, alertId: number, req: AnalysisRequest, importance: Importance): Promise<"done" | "skipped" | "failed"> {
  const { db, nowMs, provider, cfg } = ctx;
  const log = ctx.log ?? silentLogger;
  if (!provider || !cfg.ai.enabled) return "skipped";
  if (IMPORTANCE_RANK[importance] < IMPORTANCE_RANK[cfg.ai.minImportance]) return "skipped";

  const res = reserveAiCall(db, { dailyLimit: cfg.ai.dailyLimit, minIntervalSec: cfg.ai.minIntervalSec }, { nowMs, alertId, hash: payloadHash(req), model: provider.model });
  if (!res.ok) {
    // Only ever downgrade an alert that has no outcome yet: never clobber a finished analysis.
    if (res.reason !== "duplicate") db.prepare("UPDATE alerts SET ai_status = 'skipped_budget' WHERE id = ? AND ai_status = 'none'").run(alertId);
    audit(db, { kind: "ai", decision: "skipped", reason: res.reason, detail: { alertId } }, nowMs);
    return "skipped";
  }
  try {
    const out = await provider.analyze(req);
    const text = sanitizeAnalysis(out.text);
    if (!text) throw new Error("empty analysis");
    finishAiCall(db, res.id, { ok: true, inputTokens: out.inputTokens, outputTokens: out.outputTokens });
    db.prepare("UPDATE alerts SET ai_status = 'done', ai_analysis = ? WHERE id = ?").run(text, alertId);
    audit(db, { kind: "ai", decision: "analyzed", detail: { alertId, model: provider.model, in: out.inputTokens, out: out.outputTokens } }, nowMs);
    return "done";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finishAiCall(db, res.id, { ok: false, error: msg });
    db.prepare("UPDATE alerts SET ai_status = 'failed' WHERE id = ?").run(alertId);
    audit(db, { kind: "ai", decision: "failed", reason: msg.slice(0, 200), detail: { alertId } }, nowMs);
    log.warn("ai analysis failed", { alertId, err: msg });
    return "failed";
  }
}

// ---- Telegram outbox ----

type PendingAlert = {
  id: number; title: string; body: string; data_label: string | null; ai_analysis: string | null; telegram_attempts: number; created_at: number; type: string; importance: Importance;
};

export function formatTelegramMessage(a: Pick<PendingAlert, "title" | "body" | "data_label" | "ai_analysis">): string {
  const parts = [`<b>[PAPER] ${escapeHtml(a.title)}</b>`, escapeHtml(a.body)];
  if (a.data_label) parts.push(`<i>Data: ${escapeHtml(a.data_label)}</i>`);
  if (a.ai_analysis) parts.push(`AI note: ${escapeHtml(a.ai_analysis)}`);
  parts.push("<i>Paper trading only. Not financial advice.</i>");
  return parts.join("\n");
}

const BASE_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_PER_FLUSH = 5;

export type FlushDeps = {
  db: Database.Database;
  nowMs: number;
  target: TelegramTarget;
  cfg: Pick<WorkerConfig, "telegram">;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
};

/**
 * Deliver pending alerts. State lives in the alerts table, so a crash or
 * restart resumes exactly where it left off, and nothing is sent twice
 * (a row only leaves 'pending' after Telegram confirms or it is abandoned).
 */
export async function flushTelegram(d: FlushDeps): Promise<{ sent: number; failed: number; retried: number; capped: number }> {
  const { db, nowMs } = d;
  const log = d.log ?? silentLogger;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out = { sent: 0, failed: 0, retried: 0, capped: 0 };
  if (!d.cfg.telegram.enabled) return out;

  const bounds = etDayBounds(etClock(nowMs).dateKey)!;
  let sentToday = (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE telegram_status = 'sent' AND created_at >= ? AND created_at < ?").get(bounds.startMs, bounds.endMs) as { c: number }).c;

  const due = db
    .prepare(
      `SELECT id, title, body, data_label, ai_analysis, telegram_attempts, created_at, type, importance FROM alerts
       WHERE telegram_status = 'pending' AND (telegram_next_at IS NULL OR telegram_next_at <= ?) ORDER BY id LIMIT ?`
    )
    .all(nowMs, MAX_PER_FLUSH) as PendingAlert[];

  let first = true;
  for (const a of due) {
    if (sentToday >= d.cfg.telegram.dailyCap && a.importance !== "high") {
      db.prepare("UPDATE alerts SET telegram_status = 'skipped_cap' WHERE id = ?").run(a.id);
      out.capped++;
      continue;
    }
    if (!first) await sleep(1100); // Telegram allows ~1 msg/s to one chat
    first = false;

    const r = await sendTelegram(d.target, formatTelegramMessage(a), d.fetchImpl);
    if (r.ok) {
      db.prepare("UPDATE alerts SET telegram_status = 'sent', telegram_error = NULL WHERE id = ?").run(a.id);
      sentToday++;
      out.sent++;
      continue;
    }
    const attempts = a.telegram_attempts + 1;
    if (r.permanent || attempts >= MAX_ATTEMPTS) {
      db.prepare("UPDATE alerts SET telegram_status = 'failed', telegram_attempts = ?, telegram_error = ? WHERE id = ?").run(attempts, r.error, a.id);
      audit(db, { kind: "notify", decision: "telegram_failed", reason: r.error, detail: { alertId: a.id, permanent: r.permanent } }, nowMs);
      log.warn("telegram delivery failed", { alertId: a.id, err: r.error, permanent: r.permanent });
      out.failed++;
      // A permanent error (bad token, chat not found, bot blocked) applies to every message: stop hammering.
      if (r.permanent) break;
    } else {
      const wait = Math.min(Math.max((r.retryAfterSec ?? 0) * 1000, BASE_BACKOFF_MS * 2 ** (attempts - 1)), 3_600_000);
      db.prepare("UPDATE alerts SET telegram_attempts = ?, telegram_next_at = ?, telegram_error = ? WHERE id = ?").run(attempts, nowMs + wait, r.error, a.id);
      out.retried++;
      // Rate limited or server trouble: later messages would fare no better right now.
      break;
    }
  }
  return out;
}
