import type Database from "better-sqlite3";
import { etClock, etDayBounds } from "../marketdata/time.js";
import type { RiskState } from "./risk.js";

/**
 * Paper-trading ledger. This is bookkeeping in SQLite and nothing else: there is
 * no network client, broker SDK or order-routing code anywhere in this module
 * (a test enforces that across the whole source tree).
 */

export type PositionRow = {
  id: number;
  signal_id: number | null;
  symbol: string;
  strategy: string;
  side: "LONG";
  qty: number;
  entry_price: number;
  initial_stop: number;
  stop_price: number;
  target_price: number;
  risk_per_share: number;
  opened_at: number;
  session_date: string;
  status: "open" | "closed";
  last_price: number | null;
  last_price_at: number | null;
  exit_price: number | null;
  closed_at: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  fees: number;
  notes: string | null;
};

export class InsufficientCashError extends Error {
  constructor() {
    super("insufficient paper cash");
    this.name = "InsufficientCashError";
  }
}

export function getAccount(db: Database.Database): { starting_cash: number; cash: number } {
  return db.prepare("SELECT starting_cash, cash FROM paper_account WHERE id = 1").get() as { starting_cash: number; cash: number };
}

export function listOpenPositions(db: Database.Database): PositionRow[] {
  return db.prepare("SELECT * FROM paper_positions WHERE status = 'open' ORDER BY opened_at, id").all() as PositionRow[];
}

export function getPosition(db: Database.Database, id: number): PositionRow | undefined {
  return db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id) as PositionRow | undefined;
}

export function computeEquity(db: Database.Database): { cash: number; equity: number; openValue: number; unrealizedOpen: number } {
  const { cash } = getAccount(db);
  let openValue = 0;
  let unrealizedOpen = 0;
  for (const p of listOpenPositions(db)) {
    const mark = p.last_price ?? p.entry_price;
    openValue += p.qty * mark;
    unrealizedOpen += (mark - p.entry_price) * p.qty;
  }
  return { cash, equity: cash + openValue, openValue, unrealizedOpen };
}

export type OpenParams = {
  signalId: number | null;
  symbol: string;
  strategy: string;
  qty: number;
  fillPrice: number;
  stop: number;
  target: number;
  riskPerShare: number;
  nowMs: number;
  sessionDate: string;
  commission: number;
};

/** Atomically open a paper position. Idempotent per signal: a repeat returns the existing one. */
export function openPosition(db: Database.Database, p: OpenParams): { id: number; created: boolean } {
  if (!(p.qty >= 1) || !Number.isInteger(p.qty)) throw new Error("qty must be a positive whole number");
  if (!(p.fillPrice > 0) || !(p.stop > 0) || !(p.stop < p.fillPrice) || !(p.target > p.fillPrice)) throw new Error("invalid levels");
  const tx = db.transaction((): { id: number; created: boolean } => {
    if (p.signalId !== null) {
      const existing = db.prepare("SELECT id FROM paper_positions WHERE signal_id = ?").get(p.signalId) as { id: number } | undefined;
      if (existing) return { id: existing.id, created: false };
    }
    const cost = p.qty * p.fillPrice + p.commission;
    const { cash } = getAccount(db);
    if (cost > cash + 1e-9) throw new InsufficientCashError();
    const info = db
      .prepare(
        `INSERT INTO paper_positions (signal_id, symbol, strategy, side, qty, entry_price, initial_stop, stop_price, target_price,
           risk_per_share, opened_at, session_date, status, last_price, last_price_at, fees)
         VALUES (?, ?, ?, 'LONG', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`
      )
      .run(p.signalId, p.symbol, p.strategy, p.qty, p.fillPrice, p.stop, p.stop, p.target, p.riskPerShare, p.nowMs, p.sessionDate, p.fillPrice, p.nowMs, p.commission);
    const id = Number(info.lastInsertRowid);
    db.prepare("INSERT INTO paper_orders (position_id, symbol, side, kind, qty, price, fee, created_at) VALUES (?, ?, 'BUY', 'entry', ?, ?, ?, ?)").run(
      id, p.symbol, p.qty, p.fillPrice, p.commission, p.nowMs
    );
    db.prepare("UPDATE paper_account SET cash = cash - ? WHERE id = 1").run(cost);
    return { id, created: true };
  });
  return tx.immediate();
}

/** Atomically close a position. Returns null if it was already closed (so double exits are harmless). */
export function closePosition(
  db: Database.Database,
  id: number,
  fillPrice: number,
  reason: string,
  nowMs: number,
  commission: number
): PositionRow | null {
  if (!(fillPrice > 0)) throw new Error("invalid fill price");
  const tx = db.transaction((): PositionRow | null => {
    const pos = getPosition(db, id);
    if (!pos || pos.status !== "open") return null;
    const fees = pos.fees + commission;
    const realized = (fillPrice - pos.entry_price) * pos.qty - fees;
    const r = pos.risk_per_share > 0 ? realized / (pos.risk_per_share * pos.qty) : null;
    db.prepare(
      `UPDATE paper_positions SET status = 'closed', exit_price = ?, closed_at = ?, exit_reason = ?, realized_pnl = ?, r_multiple = ?,
         fees = ?, last_price = ?, last_price_at = ? WHERE id = ?`
    ).run(fillPrice, nowMs, reason, realized, r, fees, fillPrice, nowMs, id);
    db.prepare("INSERT INTO paper_orders (position_id, symbol, side, kind, qty, price, fee, created_at) VALUES (?, ?, 'SELL', ?, ?, ?, ?, ?)").run(
      id, pos.symbol, reason, pos.qty, fillPrice, commission, nowMs
    );
    db.prepare("UPDATE paper_account SET cash = cash + ? WHERE id = 1").run(pos.qty * fillPrice - commission);
    return getPosition(db, id)!;
  });
  return tx.immediate();
}

export function markPosition(db: Database.Database, id: number, price: number, nowMs: number): void {
  if (!(price > 0)) return;
  db.prepare("UPDATE paper_positions SET last_price = ?, last_price_at = ? WHERE id = ? AND status = 'open'").run(price, nowMs, id);
}

/** Raise (never lower) the stop of an open position. */
export function raiseStop(db: Database.Database, id: number, newStop: number): boolean {
  const info = db.prepare("UPDATE paper_positions SET stop_price = ? WHERE id = ? AND status = 'open' AND ? > stop_price").run(newStop, id, newStop);
  return info.changes > 0;
}

export function loadRiskState(db: Database.Database, nowMs: number): RiskState {
  const clock = etClock(nowMs);
  const bounds = etDayBounds(clock.dateKey)!;
  const { equity, cash, unrealizedOpen } = computeEquity(db);
  const open = listOpenPositions(db);
  const realized = db
    .prepare("SELECT COALESCE(SUM(realized_pnl), 0) AS v FROM paper_positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?")
    .get(bounds.startMs, bounds.endMs) as { v: number };
  const trades = db.prepare("SELECT COUNT(*) AS c FROM paper_positions WHERE opened_at >= ? AND opened_at < ?").get(bounds.startMs, bounds.endMs) as { c: number };
  const stops = db
    .prepare("SELECT symbol, MAX(closed_at) AS t FROM paper_positions WHERE exit_reason = 'stop' AND closed_at >= ? GROUP BY symbol")
    .all(nowMs - 2 * 86_400_000) as { symbol: string; t: number }[];
  return {
    equity,
    cash,
    openSymbols: open.map((p) => p.symbol),
    realizedToday: realized.v,
    unrealizedOpen,
    tradesToday: trades.c,
    lastStopOutAt: Object.fromEntries(stops.map((s) => [s.symbol, s.t])),
  };
}

export type PaperStats = {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnl: number;
  avgR: number | null;
  best: number | null;
  worst: number | null;
};

export function statsBetween(db: Database.Database, startMs: number, endMs: number): PaperStats {
  const rows = db
    .prepare("SELECT realized_pnl AS pnl, r_multiple AS r FROM paper_positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ?")
    .all(startMs, endMs) as { pnl: number; r: number | null }[];
  const wins = rows.filter((r) => r.pnl > 0).length;
  const losses = rows.filter((r) => r.pnl < 0).length;
  const rs = rows.map((r) => r.r).filter((r): r is number => r !== null);
  return {
    closedTrades: rows.length,
    wins,
    losses,
    winRate: rows.length ? wins / rows.length : null,
    totalPnl: rows.reduce((s, r) => s + r.pnl, 0),
    avgR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    best: rows.length ? Math.max(...rows.map((r) => r.pnl)) : null,
    worst: rows.length ? Math.min(...rows.map((r) => r.pnl)) : null,
  };
}

/** Wipe paper positions/orders and restore starting cash. Signals and the audit log are kept. */
export function resetPaperAccount(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM paper_orders").run();
    db.prepare("DELETE FROM paper_positions").run();
    db.prepare("UPDATE paper_account SET cash = starting_cash WHERE id = 1").run();
  });
  tx.immediate();
}
