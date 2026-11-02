import { Router } from "express";
import { z } from "zod";
import { audit, listAudit } from "../audit.js";
import { db } from "../db.js";
import { DEFAULT_RISK, RiskConfigSchema } from "../engine/risk.js";
import { closePosition, computeEquity, getPosition, listOpenPositions, loadRiskState, resetPaperAccount, statsBetween } from "../engine/paper.js";
import { getWorkerState, loadRiskConfig, MAX_WATCHLIST_SIZE, saveRiskConfig, SymbolSchema } from "../engine/store.js";
import { etClock, etDayBounds } from "../marketdata/time.js";
import { aiUsageToday } from "../notify/ai.js";
import { LimitSchema, parseBody, parseId, parseQuery, safeJson } from "./util.js";

/**
 * Everything the dashboard needs from the monitoring engine. Mounted behind requireApiKey (see app.ts).
 * Nothing here can place a real order: "paper" endpoints only edit the local SQLite ledger.
 */
export const tradingRouter = Router();

const SECRETLESS_VERSION = "0.2.0";

// ---------------------------------------------------------------- watchlists

type WatchlistRow = { id: number; name: string; created_at: string };
const symbolsOf = (id: number): string[] =>
  (db.prepare("SELECT symbol FROM watchlist_items WHERE watchlist_id = ? ORDER BY position, added_at, symbol").all(id) as { symbol: string }[]).map((r) => r.symbol);

function watchlistJson(w: WatchlistRow) {
  return { id: w.id, name: w.name, symbols: symbolsOf(w.id) };
}

tradingRouter.get("/watchlists", (_req, res) => {
  res.json((db.prepare("SELECT * FROM watchlists ORDER BY id").all() as WatchlistRow[]).map(watchlistJson));
});

const NameSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();

tradingRouter.post("/watchlists", (req, res) => {
  const body = parseBody(req, res, NameSchema);
  if (!body) return;
  try {
    const id = Number(db.prepare("INSERT INTO watchlists (name) VALUES (?)").run(body.name).lastInsertRowid);
    res.status(201).json(watchlistJson(db.prepare("SELECT * FROM watchlists WHERE id = ?").get(id) as WatchlistRow));
  } catch {
    res.status(409).json({ error: "a watchlist with that name already exists" });
  }
});

tradingRouter.delete("/watchlists/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid watchlist id" });
  if (!db.prepare("SELECT 1 FROM watchlists WHERE id = ?").get(id)) return res.status(404).json({ error: "watchlist not found" });
  const count = (db.prepare("SELECT COUNT(*) AS c FROM watchlists").get() as { c: number }).c;
  if (count <= 1) return res.status(409).json({ error: "cannot delete the only watchlist" });
  db.prepare("DELETE FROM watchlists WHERE id = ?").run(id);
  res.status(204).end();
});

function getList(req: { params: { id?: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }): WatchlistRow | null {
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "invalid watchlist id" });
    return null;
  }
  const w = db.prepare("SELECT * FROM watchlists WHERE id = ?").get(id) as WatchlistRow | undefined;
  if (!w) {
    res.status(404).json({ error: "watchlist not found" });
    return null;
  }
  return w;
}

tradingRouter.get("/watchlists/:id", (req, res) => {
  const w = getList(req, res);
  if (w) res.json(watchlistJson(w));
});

const ReplaceSchema = z.object({ symbols: z.array(SymbolSchema).max(MAX_WATCHLIST_SIZE) }).strict();

/** Replace the whole list (used for the one-time import of a browser-local watchlist). */
tradingRouter.put("/watchlists/:id/symbols", (req, res) => {
  const w = getList(req, res);
  if (!w) return;
  const body = parseBody(req, res, ReplaceSchema);
  if (!body) return;
  const unique = [...new Set(body.symbols)];
  db.transaction(() => {
    db.prepare("DELETE FROM watchlist_items WHERE watchlist_id = ?").run(w.id);
    const ins = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
    unique.forEach((s, i) => ins.run(w.id, s, i));
  }).immediate();
  res.json(watchlistJson(w));
});

const AddSchema = z.object({ symbol: SymbolSchema }).strict();

tradingRouter.post("/watchlists/:id/symbols", (req, res) => {
  const w = getList(req, res);
  if (!w) return;
  const body = parseBody(req, res, AddSchema);
  if (!body) return;
  const size = symbolsOf(w.id).length;
  const exists = db.prepare("SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?").get(w.id, body.symbol);
  if (!exists) {
    if (size >= MAX_WATCHLIST_SIZE) return res.status(409).json({ error: `a watchlist can hold at most ${MAX_WATCHLIST_SIZE} symbols` });
    db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)").run(w.id, body.symbol, size);
  }
  res.status(exists ? 200 : 201).json(watchlistJson(w)); // idempotent: adding twice is fine
});

tradingRouter.delete("/watchlists/:id/symbols/:symbol", (req, res) => {
  const w = getList(req, res);
  if (!w) return;
  const sym = SymbolSchema.safeParse(req.params.symbol);
  if (!sym.success) return res.status(400).json({ error: "invalid ticker symbol" });
  db.prepare("DELETE FROM watchlist_items WHERE watchlist_id = ? AND symbol = ?").run(w.id, sym.data);
  res.json(watchlistJson(w)); // idempotent
});

// ---------------------------------------------------------------- alerts

type AlertRow = Record<string, unknown> & { id: number };

tradingRouter.get("/alerts", (req, res) => {
  const q = parseQuery(
    req, res,
    z.object({
      limit: LimitSchema,
      unacked: z.enum(["0", "1"]).optional(),
      type: z.string().regex(/^[a-z0-9_]{1,40}$/).optional(),
      importance: z.enum(["low", "normal", "high"]).optional(),
      beforeId: z.coerce.number().int().positive().optional(),
    })
  );
  if (!q) return;
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.unacked === "1") where.push("acknowledged_at IS NULL");
  if (q.type) { where.push("type = ?"); args.push(q.type); }
  if (q.importance) { where.push("importance = ?"); args.push(q.importance); }
  if (q.beforeId) { where.push("id < ?"); args.push(q.beforeId); }
  const rows = db
    .prepare(
      `SELECT id, created_at, symbol, type, importance, title, body, data_label, ai_status, ai_analysis, acknowledged_at, telegram_status
       FROM alerts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, q.limit) as AlertRow[];
  const unack = (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE acknowledged_at IS NULL AND importance != 'low'").get() as { c: number }).c;
  res.json({ alerts: rows, unacknowledgedImportant: unack });
});

tradingRouter.post("/alerts/ack-all", (_req, res) => {
  const info = db.prepare("UPDATE alerts SET acknowledged_at = ? WHERE acknowledged_at IS NULL").run(Date.now());
  res.json({ acknowledged: info.changes });
});

tradingRouter.post("/alerts/:id/ack", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid alert id" });
  const info = db.prepare("UPDATE alerts SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").run(Date.now(), id);
  if (info.changes === 0) return res.status(404).json({ error: "alert not found" });
  res.status(204).end();
});

// ---------------------------------------------------------------- signals

tradingRouter.get("/signals", (req, res) => {
  const q = parseQuery(
    req, res,
    z.object({ limit: LimitSchema, status: z.enum(["pending", "filled", "blocked", "expired", "invalidated", "skipped_chase"]).optional() })
  );
  if (!q) return;
  const rows = db
    .prepare(`SELECT * FROM signals ${q.status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT ?`)
    .all(...(q.status ? [q.status, q.limit] : [q.limit])) as Record<string, unknown>[];
  res.json(rows.map((r) => ({ ...r, meta: safeJson(r.meta as string, {}), risk_verdict: safeJson(r.risk_verdict as string) })));
});

// ---------------------------------------------------------------- paper trading

function accountSummary() {
  const now = Date.now();
  const acct = db.prepare("SELECT starting_cash, cash FROM paper_account WHERE id = 1").get() as { starting_cash: number; cash: number };
  const eq = computeEquity(db);
  const state = loadRiskState(db, now);
  const cfg = loadRiskConfig(db).config;
  const openRisk = listOpenPositions(db).reduce((s, p) => s + Math.max(0, (p.last_price ?? p.entry_price) - p.stop_price) * p.qty, 0);
  const all = statsBetween(db, 0, now + 1);
  const today = etDayBounds(etClock(now).dateKey)!;
  return {
    mode: "paper" as const,
    startingCash: acct.starting_cash,
    cash: acct.cash,
    equity: eq.equity,
    openValue: eq.openValue,
    unrealizedPnl: eq.unrealizedOpen,
    realizedToday: state.realizedToday,
    dailyPnl: state.realizedToday + state.unrealizedOpen,
    allTimePnl: eq.equity - acct.starting_cash,
    tradesToday: state.tradesToday,
    openPositions: state.openSymbols.length,
    openRisk,
    limits: { maxOpenPositions: cfg.maxOpenPositions, maxTradesPerDay: cfg.maxTradesPerDay, maxDailyLossPct: cfg.maxDailyLossPct, tradingEnabled: cfg.tradingEnabled },
    today: statsBetween(db, today.startMs, today.endMs),
    allTime: all,
  };
}

tradingRouter.get("/paper/account", (_req, res) => res.json(accountSummary()));

tradingRouter.get("/paper/positions", (req, res) => {
  const q = parseQuery(req, res, z.object({ limit: LimitSchema, status: z.enum(["open", "closed", "all"]).default("all") }));
  if (!q) return;
  const rows = db
    .prepare(`SELECT * FROM paper_positions ${q.status === "all" ? "" : "WHERE status = ?"} ORDER BY (status = 'open') DESC, COALESCE(closed_at, opened_at) DESC LIMIT ?`)
    .all(...(q.status === "all" ? [q.limit] : [q.status, q.limit]));
  res.json(rows);
});

tradingRouter.get("/paper/orders", (req, res) => {
  const q = parseQuery(req, res, z.object({ limit: LimitSchema }));
  if (!q) return;
  res.json(db.prepare("SELECT * FROM paper_orders ORDER BY id DESC LIMIT ?").all(q.limit));
});

const MANUAL_CLOSE_MAX_AGE_MS = 15 * 60_000;

/** Close a paper position at its last known mark. Paper only: this edits a local ledger and nothing else. */
tradingRouter.post("/paper/positions/:id/close", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid position id" });
  const pos = getPosition(db, id);
  if (!pos) return res.status(404).json({ error: "position not found" });
  if (pos.status !== "open") return res.status(409).json({ error: "position is already closed" });
  const now = Date.now();
  if (pos.last_price === null || pos.last_price_at === null || now - pos.last_price_at > MANUAL_CLOSE_MAX_AGE_MS) {
    return res.status(409).json({ error: "no recent price for this position (the monitor has not marked it in 15 minutes); try again when data recovers" });
  }
  const fee = loadRiskConfig(db).config.commissionPerOrder;
  const closed = closePosition(db, id, pos.last_price, "manual", now, fee);
  if (!closed) return res.status(409).json({ error: "position is already closed" });
  audit(db, { kind: "order", symbol: pos.symbol, decision: "paper_sell", reason: "manual", detail: { positionId: id, fill: pos.last_price, pnl: closed.realized_pnl } }, now);
  res.json(closed);
});

const NotesSchema = z.object({ notes: z.string().max(2000) }).strict();

tradingRouter.patch("/paper/positions/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid position id" });
  const body = parseBody(req, res, NotesSchema);
  if (!body) return;
  const info = db.prepare("UPDATE paper_positions SET notes = ? WHERE id = ?").run(body.notes, id);
  if (info.changes === 0) return res.status(404).json({ error: "position not found" });
  res.json(getPosition(db, id));
});

tradingRouter.post("/paper/reset", (req, res) => {
  const body = parseBody(req, res, z.object({ confirm: z.literal("RESET") }).strict());
  if (!body) return;
  resetPaperAccount(db);
  audit(db, { kind: "api", decision: "paper_account_reset" }, Date.now());
  res.json(accountSummary());
});

// ---------------------------------------------------------------- monitor status

type Heartbeat = {
  startedAt: number; tickAt: number; tickMs: number; tickCount: number; errorCount: number; lastError: string | null; quoteFailures: number;
  symbols: number; eligible: number; phase: string; pollSeconds: number; tradingMode: string; telegram: boolean; ai: boolean;
  aiUsage: { day: string; used: number; limit: number; remaining: number };
};

tradingRouter.get("/monitor/status", (_req, res) => {
  const now = Date.now();
  const hb = getWorkerState<Heartbeat>(db, "heartbeat");
  const conditions = getWorkerState(db, "market_conditions");
  const ageSec = hb ? Math.round((now - hb.value.tickAt) / 1000) : null;
  // "Running" means a tick completed recently relative to the worker's own poll interval (plus idle slack).
  const staleAfter = hb ? Math.max(hb.value.pollSeconds * 3, 900) : 900;
  const running = ageSec !== null && ageSec <= staleAfter;
  const cfg = loadRiskConfig(db);
  res.json({
    version: SECRETLESS_VERSION,
    mode: "paper",
    worker: {
      running,
      heartbeatAgeSec: ageSec,
      startedAt: hb?.value.startedAt ?? null,
      tickCount: hb?.value.tickCount ?? 0,
      errorCount: hb?.value.errorCount ?? 0,
      lastError: hb?.value.lastError ?? null,
      quoteFailures: hb?.value.quoteFailures ?? 0,
      monitoredSymbols: hb?.value.symbols ?? 0,
      eligibleSymbols: hb?.value.eligible ?? 0,
      phase: hb?.value.phase ?? "unknown",
      pollSeconds: hb?.value.pollSeconds ?? null,
      lastTickMs: hb?.value.tickMs ?? null,
    },
    notifications: { telegram: hb?.value.telegram ?? false },
    ai: hb ? { enabled: hb.value.ai, ...aiUsageToday(db, now, hb.value.aiUsage.limit) } : { enabled: false, used: 0, limit: 0, remaining: 0 },
    marketConditions: conditions?.value ?? null,
    conditionsAgeSec: conditions ? Math.round((now - conditions.updatedAt) / 1000) : null,
    risk: { config: cfg.config, usingDefaultsBecauseStoredInvalid: cfg.fellBack },
    counts: {
      pendingSignals: (db.prepare("SELECT COUNT(*) AS c FROM signals WHERE status = 'pending'").get() as { c: number }).c,
      unacknowledgedAlerts: (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE acknowledged_at IS NULL").get() as { c: number }).c,
    },
    disclaimer: "Paper trading only. Prices come from free public endpoints and are delayed or indicative.",
  });
});

// ---------------------------------------------------------------- risk configuration

tradingRouter.get("/risk/config", (_req, res) => {
  const { config, fellBack } = loadRiskConfig(db);
  res.json({ config, defaults: DEFAULT_RISK, usingDefaultsBecauseStoredInvalid: fellBack });
});

tradingRouter.put("/risk/config", (req, res) => {
  const before = loadRiskConfig(db).config;
  const r = saveRiskConfig(db, req.body, Date.now());
  if (!r.ok) return res.status(400).json({ error: r.error });
  const changed = Object.fromEntries(Object.entries(r.config).filter(([k, v]) => (before as Record<string, unknown>)[k] !== v));
  audit(db, { kind: "config", decision: "risk_updated", detail: { changed } }, Date.now());
  res.json({ config: r.config });
});

// ---------------------------------------------------------------- reports + audit

tradingRouter.get("/reports", (req, res) => {
  const q = parseQuery(req, res, z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), kind: z.enum(["daily", "weekly"]).optional() }));
  if (!q) return;
  res.json(
    db
      .prepare(`SELECT id, kind, period_key, created_at, title FROM reports ${q.kind ? "WHERE kind = ?" : ""} ORDER BY period_key DESC, id DESC LIMIT ?`)
      .all(...(q.kind ? [q.kind, q.limit] : [q.limit]))
  );
});

tradingRouter.get("/reports/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid report id" });
  const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as (Record<string, unknown> & { data: string }) | undefined;
  if (!r) return res.status(404).json({ error: "report not found" });
  res.json({ ...r, data: safeJson(r.data, {}) });
});

tradingRouter.get("/audit", (req, res) => {
  const q = parseQuery(
    req, res,
    z.object({
      limit: LimitSchema,
      kind: z.enum(["signal", "risk", "order", "alert", "ai", "notify", "data", "system", "config", "api"]).optional(),
      symbol: SymbolSchema.optional(),
      beforeId: z.coerce.number().int().positive().optional(),
    })
  );
  if (!q) return;
  res.json(listAudit(db, q).map((r) => ({ ...r, detail: safeJson(r.detail) })));
});

export const TRADING_PREFIXES = ["/watchlists", "/alerts", "/signals", "/paper", "/monitor", "/risk", "/reports", "/audit"];
void RiskConfigSchema;
