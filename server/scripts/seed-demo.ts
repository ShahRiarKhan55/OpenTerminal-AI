/**
 * Populates a database with clearly-labelled DEMO data so the dashboard can be explored (or screenshot-tested)
 * without waiting for a live market session.   DATA_DIR=/some/scratch/dir npx tsx scripts/seed-demo.ts
 *
 * Safety: it requires DATA_DIR to be set explicitly and refuses to run if the database already contains
 * alerts or paper positions, so it can never be mixed into real history by accident.
 */
if (!process.env.DATA_DIR) {
  console.error("seed-demo: set DATA_DIR to a scratch directory (refusing to touch the default data/ folder)");
  process.exit(2);
}
const { db } = await import("../src/db.js");
const { raiseAlert } = await import("../src/notify/alerts.js");
const { openPosition, closePosition, markPosition } = await import("../src/engine/paper.js");
const { insertSignal, setSignalStatus, setWorkerState } = await import("../src/engine/store.js");
const { audit } = await import("../src/audit.js");
const { loadWorkerConfig } = await import("../src/config.js");

const existing = (db.prepare("SELECT (SELECT COUNT(*) FROM alerts) + (SELECT COUNT(*) FROM paper_positions) AS c").get() as { c: number }).c;
if (existing > 0) {
  console.error("seed-demo: database already has alerts or paper positions; refusing to add demo data");
  process.exit(3);
}

const now = Date.now();
const min = 60_000;
const cfg = loadWorkerConfig({ TELEGRAM_ENABLED: "false" });
const alert = (agoMin: number, type: string, importance: "low" | "normal" | "high", symbol: string | null, title: string, body: string, key: string) =>
  raiseAlert({ db, nowMs: now - agoMin * min, cfg }, { type, symbol, importance, dedupeKey: key, cooldownMs: 1, title: `[DEMO] ${title}`, body, dataLabel: "provider-reported real-time · 8s old · nasdaq" });

const sigId = (symbol: string, strategy: "orb" | "breakout20", entry: number, stop: number, target: number, status: "filled" | "blocked" | "pending", reason?: string) => {
  const row = insertSignal(db, { symbol, strategy, side: "LONG", entry, stop, target, riskPerShare: entry - stop, rewardRisk: 2, validUntilMs: now + 30 * min, sessionDate: new Date(now).toISOString().slice(0, 10), meta: {} }, now - 90 * min)!;
  if (status !== "pending") setSignalStatus(db, row.id, status, now - 89 * min, { reason });
  return row.id;
};

const s1 = sigId("NVDA", "orb", 142.1, 141.2, 143.9, "filled");
const s2 = sigId("AAPL", "breakout20", 231.4, 229.1, 236, "filled");
const s3 = sigId("TSLA", "orb", 251.8, 249.9, 255.6, "filled");
sigId("MSFT", "orb", 428.5, 426.9, 431.7, "blocked", "max_open_positions");
sigId("AMZN", "breakout20", 189.2, 186.9, 193.8, "pending");

const win = openPosition(db, { signalId: s1, symbol: "NVDA", strategy: "orb", qty: 180, fillPrice: 142.17, stop: 141.2, target: 143.9, riskPerShare: 0.97, nowMs: now - 85 * min, sessionDate: "demo", commission: 0 });
closePosition(db, win.id, 143.9, "target", now - 52 * min, 0);
const loss = openPosition(db, { signalId: s3, symbol: "TSLA", strategy: "orb", qty: 120, fillPrice: 251.9, stop: 249.9, target: 255.6, riskPerShare: 2, nowMs: now - 70 * min, sessionDate: "demo", commission: 0 });
closePosition(db, loss.id, 249.6, "stop", now - 40 * min, 0);
const open = openPosition(db, { signalId: s2, symbol: "AAPL", strategy: "breakout20", qty: 95, fillPrice: 231.5, stop: 229.1, target: 236, riskPerShare: 2.4, nowMs: now - 30 * min, sessionDate: new Date(now).toISOString().slice(0, 10), commission: 0 });
markPosition(db, open.id, 233.2, now - 20_000);

alert(88, "signal", "normal", "NVDA", "NVDA ORB long setup", "Opening-range breakout. Entry 142.10, stop 141.20, target 143.90 (R:R 2.0).", "d1");
alert(30, "signal", "normal", "AAPL", "AAPL BREAKOUT20 long setup", "20-day high breakout. Entry 231.40, stop 229.10, target 236.00 (R:R 2.0).", "d2");
alert(29, "position_opened", "normal", "AAPL", "Paper BUY 95 AAPL @ 231.50", "BREAKOUT20 entry filled in the paper account. Simulated fill includes 5 bps slippage.", "d3");
alert(40, "position_closed", "high", "TSLA", "Paper SELL TSLA (stop) -$220.50", "120 sh closed at 249.60. Result -$276.00, -1.15R.", "d4");
alert(52, "position_closed", "normal", "NVDA", "Paper SELL NVDA (target) +$311.40", "180 sh closed at 143.90. Result +$311.40, 1.78R.", "d5");
alert(120, "econ_event_soon", "normal", null, "CPI m/m in 25 min", "High-impact US release. Forecast 0.3%, previous 0.2%.", "d6");
alert(15, "move_up", "high", "AMD", "AMD up 5.4% today", "AMD is up 5.40% versus the previous close (last 168.20).", "d7");
alert(10, "rsi_overbought", "low", "AMD", "AMD daily RSI 74 (overbought)", "An extreme reading is context, not a signal.", "d8");
alert(5, "signal_blocked", "low", "MSFT", "MSFT ORB setup blocked by risk rules", "Not taken: max open positions.", "d9");
db.prepare("UPDATE alerts SET ai_status = 'done', ai_analysis = ? WHERE type = 'signal' AND symbol = 'AAPL'").run(
  "Breakout above the 20-day high on above-average volume with price over the 50-day average. Main risk: a failed breakout reverting into the prior range; a close back under the entry level would invalidate it. Data is delayed/indicative."
);

// Three real AI-usage rows for today, so the budget meter reflects the database (its only source of truth).
const { etClock } = await import("../src/marketdata/time.js");
for (let i = 0; i < 3; i++) {
  db.prepare("INSERT INTO ai_calls (ts, day, alert_id, payload_hash, model, status, input_tokens, output_tokens) VALUES (?, ?, NULL, ?, 'demo-model', 'ok', 400, 120)").run(now - (i + 1) * 20 * min, etClock(now).dateKey, `demo${i}`);
}
audit(db, { kind: "risk", symbol: "MSFT", decision: "blocked", reason: "max_open_positions" }, now - 5 * min);
setWorkerState(db, "heartbeat", {
  pid: 1, startedAt: now - 3 * 3_600_000, tickAt: now - 12_000, tickMs: 1800, tickCount: 180, errorCount: 2, lastError: null, quoteFailures: 0,
  symbols: 8, eligible: 8, phase: "open", pollSeconds: 60, tradingMode: "paper", telegram: true, ai: true, aiUsage: { day: "demo", used: 3, limit: 10, remaining: 7 },
}, now);
setWorkerState(db, "market_conditions", {
  asOf: now, regime: "risk_on", vix: 14.2, note: "SPY 0.62%, VIX 14.2.",
  indices: [
    { symbol: "SPY", price: 598.4, changePercent: 0.62, ageSec: 6, delayClass: "realtime", eligible: true },
    { symbol: "QQQ", price: 521.7, changePercent: 0.88, ageSec: 6, delayClass: "realtime", eligible: true },
    { symbol: "IWM", price: 224.3, changePercent: 0.21, ageSec: 9, delayClass: "realtime", eligible: true },
  ],
}, now);
db.prepare("INSERT INTO reports (kind, period_key, created_at, title, body, data) VALUES ('daily', ?, ?, ?, ?, '{}')").run(
  "demo-day", now - 20 * 3_600_000, "[DEMO] Daily report", "Daily paper-trading report (demo data)\nAll figures are SIMULATED.\nClosed trades: 2 (1 win / 1 loss, win rate 50%). Net P&L $35.40."
);
console.log("seed-demo: demo data written to", process.env.DATA_DIR);
db.close();
