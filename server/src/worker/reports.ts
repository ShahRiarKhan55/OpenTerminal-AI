import type Database from "better-sqlite3";
import { audit } from "../audit.js";
import { computeEquity, listOpenPositions, statsBetween } from "../engine/paper.js";
import { getWorkerState } from "../engine/store.js";
import { etClock, etDayBounds } from "../marketdata/time.js";
import { raiseAlert } from "../notify/alerts.js";
import type { MarketConditions } from "../engine/marketEvents.js";
import type { Runtime, WorkerDeps } from "./runtime.js";

const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number | null) => (n === null ? "n/a" : `${(n * 100).toFixed(0)}%`);

export function mondayOf(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}

function addDays(dateKey: string, n: number): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

type Period = { startMs: number; endMs: number };

function summarize(db: Database.Database, period: Period) {
  const stats = statsBetween(db, period.startMs, period.endMs);
  const signals = db
    .prepare("SELECT status, COUNT(*) c FROM signals WHERE created_at >= ? AND created_at < ? GROUP BY status")
    .all(period.startMs, period.endMs) as { status: string; c: number }[];
  const alerts = db
    .prepare("SELECT importance, COUNT(*) c FROM alerts WHERE created_at >= ? AND created_at < ? GROUP BY importance")
    .all(period.startMs, period.endMs) as { importance: string; c: number }[];
  const rejections = db
    .prepare("SELECT reason, COUNT(*) c FROM audit_log WHERE kind = 'data' AND decision = 'rejected' AND ts >= ? AND ts < ? GROUP BY reason ORDER BY c DESC")
    .all(period.startMs, period.endMs) as { reason: string; c: number }[];
  const trades = db
    .prepare(
      "SELECT symbol, strategy, realized_pnl AS pnl, r_multiple AS r, exit_reason AS reason FROM paper_positions WHERE status = 'closed' AND closed_at >= ? AND closed_at < ? ORDER BY closed_at"
    )
    .all(period.startMs, period.endMs) as { symbol: string; strategy: string; pnl: number; r: number | null; reason: string }[];
  const aiCalls = (db.prepare("SELECT COUNT(*) c FROM ai_calls WHERE ts >= ? AND ts < ?").get(period.startMs, period.endMs) as { c: number }).c;
  return { stats, signals, alerts, rejections, trades, aiCalls };
}

export function buildReport(db: Database.Database, kind: "daily" | "weekly", label: string, period: Period) {
  const s = summarize(db, period);
  const eq = computeEquity(db);
  const start = (db.prepare("SELECT starting_cash FROM paper_account WHERE id = 1").get() as { starting_cash: number }).starting_cash;
  const cond = getWorkerState<MarketConditions>(db, "market_conditions")?.value;
  const lines: string[] = [];
  lines.push(`${kind === "daily" ? "Daily" : "Weekly"} paper-trading report: ${label}`);
  lines.push("All figures are SIMULATED paper trades on delayed/indicative public data. Not financial advice.");
  lines.push("");
  if (kind === "daily" && cond) lines.push(`Market: ${cond.regime.replace("_", "-")}${cond.vix !== null ? `, VIX ${cond.vix.toFixed(1)}` : ""}.`);
  lines.push(
    `Closed trades: ${s.stats.closedTrades} (${s.stats.wins} win / ${s.stats.losses} loss, win rate ${pct(s.stats.winRate)}). ` +
      `Net P&L ${money(s.stats.totalPnl)}${s.stats.avgR !== null ? `, average ${s.stats.avgR.toFixed(2)}R` : ""}.`
  );
  if (s.trades.length) {
    lines.push("Trades:");
    for (const t of s.trades.slice(0, 20)) lines.push(`  - ${t.symbol} ${t.strategy} ${money(t.pnl)}${t.r !== null ? ` (${t.r.toFixed(2)}R)` : ""} via ${t.reason}`);
  }
  lines.push(`Account: equity ${money(eq.equity)} (started ${money(start)}, ${money(eq.equity - start)} all-time), cash ${money(eq.cash)}, ${listOpenPositions(db).length} open.`);
  const sig = s.signals.map((x) => `${x.c} ${x.status}`).join(", ");
  lines.push(`Signals: ${sig || "none"}.`);
  lines.push(`Alerts: ${s.alerts.map((x) => `${x.c} ${x.importance}`).join(", ") || "none"}. AI analyses used: ${s.aiCalls}.`);
  lines.push(`Data quality: ${s.rejections.length ? s.rejections.map((x) => `${x.c}x ${x.reason.replace(/_/g, " ")}`).join(", ") + " rejected" : "no rejected observations logged"}.`);
  return {
    title: `${kind === "daily" ? "Daily" : "Weekly"} report ${label}`,
    body: lines.join("\n"),
    summary: `${s.stats.closedTrades} trades, ${money(s.stats.totalPnl)}, equity ${money(eq.equity)}`,
    data: { ...s, equity: eq.equity, cash: eq.cash },
  };
}

function periodForDay(dateKey: string): Period | null {
  const b = etDayBounds(dateKey);
  return b ? { startMs: b.startMs, endMs: b.endMs } : null;
}

/**
 * Idempotent: (kind, period_key) is UNIQUE, so a restart, a retry or two overlapping
 * ticks can never create a duplicate report. Daily reports are only produced for days
 * the market was actually seen open (so holidays and weekends stay quiet), and catch up
 * automatically if the worker was down at 16:20 ET.
 */
export function maybeCreateReports(deps: WorkerDeps, rt: Runtime): void {
  const { db, cfg, now } = { ...deps, now: deps.now() };
  void rt;
  const clock = etClock(now);
  const openDates = getWorkerState<string[]>(db, "open_dates")?.value ?? [];
  const exists = db.prepare("SELECT 1 FROM reports WHERE kind = ? AND period_key = ?");
  const insert = db.prepare("INSERT OR IGNORE INTO reports (kind, period_key, created_at, title, body, data) VALUES (?, ?, ?, ?, ?, ?)");

  // Every market day we saw open and have not reported yet, once its session is over. Iterating ALL
  // open dates (not just the latest) is what makes catch-up work when the worker restarts after the
  // NEXT day's open: yesterday's report is still produced.
  for (const date of openDates) {
    const over = date < clock.dateKey || (date === clock.dateKey && clock.minutes >= 16 * 60 + 20);
    if (!over || exists.get("daily", date)) continue;
    const period = periodForDay(date);
    if (!period) continue;
    const r = buildReport(db, "daily", date, period);
    if (insert.run("daily", date, now, r.title, r.body, JSON.stringify(r.data)).changes > 0) {
      audit(db, { kind: "system", decision: "report_created", reason: `daily:${date}` }, now);
      raiseAlert({ db, nowMs: now, cfg }, { type: "report_daily", symbol: null, importance: "normal", dedupeKey: `report:daily:${date}`, cooldownMs: 7 * 86_400_000, title: r.title, body: r.summary });
    }
  }

  // Weekly: any week with a daily report, once that week is over (or on Friday after the close).
  const dailies = db.prepare("SELECT period_key FROM reports WHERE kind = 'daily' ORDER BY period_key DESC LIMIT 30").all() as { period_key: string }[];
  const weeks = new Set(dailies.map((d) => mondayOf(d.period_key)));
  for (const monday of weeks) {
    if (exists.get("weekly", monday)) continue;
    const friday = addDays(monday, 4);
    const weekOver = clock.dateKey > friday || (clock.dateKey === friday && clock.minutes >= 16 * 60 + 25);
    if (!weekOver) continue;
    const a = etDayBounds(monday);
    const b = etDayBounds(addDays(monday, 5)); // Saturday 00:00 ET
    if (!a || !b) continue;
    const r = buildReport(db, "weekly", `week of ${monday}`, { startMs: a.startMs, endMs: b.startMs });
    if (insert.run("weekly", monday, now, r.title, r.body, JSON.stringify(r.data)).changes > 0) {
      audit(db, { kind: "system", decision: "report_created", reason: `weekly:${monday}` }, now);
      raiseAlert({ db, nowMs: now, cfg }, { type: "report_weekly", symbol: null, importance: "normal", dedupeKey: `report:weekly:${monday}`, cooldownMs: 14 * 86_400_000, title: r.title, body: r.summary });
    }
  }
}
