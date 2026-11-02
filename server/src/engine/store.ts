import type Database from "better-sqlite3";
import { z } from "zod";
import { DEFAULT_RISK, RiskConfigSchema, type RiskConfig } from "./risk.js";
import type { SignalCandidate } from "./types.js";

// ---- settings (key/value JSON) ----

export function getSetting(db: Database.Database, key: string): string | null {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string, nowMs: number): void {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, value, nowMs);
}

/**
 * Stored overrides merged over defaults and re-validated. A corrupt or
 * out-of-bounds stored value falls back to the safe defaults instead of
 * crashing the worker or, worse, running with unchecked limits.
 */
export function loadRiskConfig(db: Database.Database): { config: RiskConfig; fellBack: boolean } {
  const raw = getSetting(db, "risk_config");
  if (!raw) return { config: DEFAULT_RISK, fellBack: false };
  try {
    const parsed = RiskConfigSchema.safeParse({ ...DEFAULT_RISK, ...JSON.parse(raw) });
    if (parsed.success) return { config: parsed.data, fellBack: false };
  } catch {
    /* fall through */
  }
  return { config: DEFAULT_RISK, fellBack: true };
}

export function saveRiskConfig(
  db: Database.Database,
  patch: unknown,
  nowMs: number
): { ok: true; config: RiskConfig } | { ok: false; error: string } {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return { ok: false, error: "body must be an object" };
  const merged = RiskConfigSchema.safeParse({ ...loadRiskConfig(db).config, ...(patch as object) });
  if (!merged.success) return { ok: false, error: merged.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ") };
  setSetting(db, "risk_config", JSON.stringify(merged.data), nowMs);
  return { ok: true, config: merged.data };
}

// ---- worker state ----

export function setWorkerState(db: Database.Database, key: string, value: unknown, nowMs: number): void {
  db.prepare(
    "INSERT INTO worker_state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, JSON.stringify(value), nowMs);
}

export function getWorkerState<T = unknown>(db: Database.Database, key: string): { value: T; updatedAt: number } | null {
  const r = db.prepare("SELECT value, updated_at FROM worker_state WHERE key = ?").get(key) as { value: string; updated_at: number } | undefined;
  if (!r) return null;
  try {
    return { value: JSON.parse(r.value) as T, updatedAt: r.updated_at };
  } catch {
    return null;
  }
}

// ---- watchlists ----

export const SYMBOL_RE = /^[A-Z][A-Z0-9]{0,4}([.-][A-Z0-9]{1,2})?$/;
export const MAX_WATCHLIST_SIZE = 100;

export const SymbolSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => SYMBOL_RE.test(s), "invalid ticker symbol");

/** Unique symbols across every watchlist, in a stable order, capped to protect provider rate limits. */
export function monitoredSymbols(db: Database.Database, cap: number): { symbols: string[]; truncated: boolean } {
  const rows = db
    .prepare("SELECT symbol FROM watchlist_items GROUP BY symbol ORDER BY MIN(watchlist_id), MIN(position), symbol")
    .all() as { symbol: string }[];
  const all = rows.map((r) => r.symbol);
  return { symbols: all.slice(0, cap), truncated: all.length > cap };
}

// ---- signals ----

export type SignalStatus = "pending" | "filled" | "blocked" | "expired" | "invalidated" | "skipped_chase";

export type SignalRow = {
  id: number;
  created_at: number;
  symbol: string;
  strategy: string;
  side: "LONG";
  status: SignalStatus;
  entry: number;
  stop: number;
  target: number;
  risk_per_share: number;
  reward_risk: number;
  valid_until: number;
  session_date: string;
  meta: string;
  risk_verdict: string | null;
  reason: string | null;
  updated_at: number;
};

/** Insert a new signal; returns null if this strategy/symbol/session already produced one (dedupe). */
export function insertSignal(db: Database.Database, c: SignalCandidate, nowMs: number): SignalRow | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO signals (created_at, symbol, strategy, side, status, entry, stop, target, risk_per_share, reward_risk,
         valid_until, session_date, meta, updated_at)
       VALUES (?, ?, ?, 'LONG', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(nowMs, c.symbol, c.strategy, c.entry, c.stop, c.target, c.riskPerShare, c.rewardRisk, c.validUntilMs, c.sessionDate, JSON.stringify(c.meta), nowMs);
  if (info.changes === 0) return null;
  return db.prepare("SELECT * FROM signals WHERE id = ?").get(Number(info.lastInsertRowid)) as SignalRow;
}

export function setSignalStatus(
  db: Database.Database,
  id: number,
  status: SignalStatus,
  nowMs: number,
  extra: { reason?: string; verdict?: unknown } = {}
): void {
  db.prepare("UPDATE signals SET status = ?, updated_at = ?, reason = COALESCE(?, reason), risk_verdict = COALESCE(?, risk_verdict) WHERE id = ?").run(
    status, nowMs, extra.reason ?? null, extra.verdict === undefined ? null : JSON.stringify(extra.verdict), id
  );
}

export function pendingSignals(db: Database.Database): SignalRow[] {
  return db.prepare("SELECT * FROM signals WHERE status = 'pending' ORDER BY id").all() as SignalRow[];
}
