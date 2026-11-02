import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = "trading-test-key-0123456789";
let tmpDir: string;
let server: Server;
let base: string;
let db: (typeof import("../db.js"))["db"];
let mod: {
  raiseAlert: typeof import("../notify/alerts.js")["raiseAlert"];
  openPosition: typeof import("../engine/paper.js")["openPosition"];
  markPosition: typeof import("../engine/paper.js")["markPosition"];
  closePosition: typeof import("../engine/paper.js")["closePosition"];
  insertSignal: typeof import("../engine/store.js")["insertSignal"];
  setWorkerState: typeof import("../engine/store.js")["setWorkerState"];
  audit: typeof import("../audit.js")["audit"];
  cfg: ReturnType<typeof import("../config.js")["loadWorkerConfig"]>;
};

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ot-trading-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.API_KEY = KEY;
  const { createApp } = await import("../app.js");
  ({ db } = await import("../db.js"));
  const [alerts, paper, store, auditMod, config] = await Promise.all([
    import("../notify/alerts.js"), import("../engine/paper.js"), import("../engine/store.js"), import("../audit.js"), import("../config.js"),
  ]);
  mod = {
    raiseAlert: alerts.raiseAlert, openPosition: paper.openPosition, markPosition: paper.markPosition, closePosition: paper.closePosition,
    insertSignal: store.insertSignal, setWorkerState: store.setWorkerState, audit: auditMod.audit, cfg: config.loadWorkerConfig({}),
  };
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.API_KEY;
});

async function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers["x-api-key"] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

describe("authorization: EVERY engine endpoint requires the API key", () => {
  const endpoints: [string, string][] = [
    ["GET", "/api/watchlists"], ["POST", "/api/watchlists"], ["GET", "/api/watchlists/1"], ["DELETE", "/api/watchlists/1"],
    ["PUT", "/api/watchlists/1/symbols"], ["POST", "/api/watchlists/1/symbols"], ["DELETE", "/api/watchlists/1/symbols/AAPL"],
    ["GET", "/api/alerts"], ["POST", "/api/alerts/ack-all"], ["POST", "/api/alerts/1/ack"],
    ["GET", "/api/signals"],
    ["GET", "/api/paper/account"], ["GET", "/api/paper/positions"], ["GET", "/api/paper/orders"],
    ["POST", "/api/paper/positions/1/close"], ["PATCH", "/api/paper/positions/1"], ["POST", "/api/paper/reset"],
    ["GET", "/api/monitor/status"], ["GET", "/api/risk/config"], ["PUT", "/api/risk/config"],
    ["GET", "/api/reports"], ["GET", "/api/reports/1"], ["GET", "/api/audit"],
  ];
  it.each(endpoints)("%s %s -> 401 without a key", async (method, path) => {
    const r = await call(method, path, ["POST", "PUT", "PATCH"].includes(method) ? {} : undefined, null);
    expect(r.status).toBe(401);
  });
  it.each(endpoints.slice(0, 6))("%s %s -> 401 with a wrong key", async (method, path) => {
    expect((await call(method, path, ["POST", "PUT"].includes(method) ? {} : undefined, "nope")).status).toBe(401);
  });
  it("does not require a key for the public market routes or status (unchanged)", async () => {
    expect((await call("GET", "/api/status", undefined, null)).status).toBe(200);
  });
  it("a request that merely looks like an engine prefix is not routed into it", async () => {
    expect((await call("GET", "/api/alertsx", undefined, null)).status).toBe(404);
    expect((await call("GET", "/api/paperwork", undefined, null)).status).toBe(404);
  });
});

describe("watchlists", () => {
  let defaultId: number;
  it("starts with the seeded Default list", async () => {
    const r = await call("GET", "/api/watchlists");
    expect(r.status).toBe(200);
    const d = r.json.find((w: { name: string }) => w.name === "Default");
    expect(d.symbols).toEqual(["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "SPY"]);
    defaultId = d.id;
  });

  it("adds symbols normalized to upper case, idempotently, and removes them", async () => {
    const a = await call("POST", `/api/watchlists/${defaultId}/symbols`, { symbol: " brk.b " });
    expect(a.status).toBe(201);
    expect(a.json.symbols).toContain("BRK.B");
    const again = await call("POST", `/api/watchlists/${defaultId}/symbols`, { symbol: "BRK.B" });
    expect(again.status).toBe(200);
    expect(again.json.symbols.filter((s: string) => s === "BRK.B")).toHaveLength(1);
    const del = await call("DELETE", `/api/watchlists/${defaultId}/symbols/brk.b`);
    expect(del.status).toBe(200);
    expect(del.json.symbols).not.toContain("BRK.B");
    expect((await call("DELETE", `/api/watchlists/${defaultId}/symbols/brk.b`)).status).toBe(200); // idempotent
  });

  it.each(["", "AAPL;DROP TABLE alerts", "../etc", "A B", "<script>", "TOOLONGSYMBOL", "^VIX", "1ABC"])("rejects bad symbol %j", async (symbol) => {
    expect((await call("POST", `/api/watchlists/${defaultId}/symbols`, { symbol })).status).toBe(400);
  });

  it("rejects unknown fields and non-objects (strict schemas)", async () => {
    expect((await call("POST", `/api/watchlists/${defaultId}/symbols`, { symbol: "AAPL", extra: 1 })).status).toBe(400);
    expect((await call("POST", `/api/watchlists/${defaultId}/symbols`, "AAPL")).status).toBe(400);
    expect((await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: "AAPL" })).status).toBe(400);
  });

  it("replaces a whole list (the browser import), de-duplicating and validating all-or-nothing", async () => {
    const before = (await call("GET", `/api/watchlists/${defaultId}`)).json.symbols;
    const bad = await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: ["AAPL", "NOT VALID"] });
    expect(bad.status).toBe(400);
    expect((await call("GET", `/api/watchlists/${defaultId}`)).json.symbols).toEqual(before); // untouched
    const ok = await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: ["msft", "AAPL", "MSFT", "SPY"] });
    expect(ok.json.symbols).toEqual(["MSFT", "AAPL", "SPY"]);
    await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: before });
  });

  it("caps a list at 100 symbols", async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `A${i}`.slice(0, 5));
    expect((await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: tooMany })).status).toBe(400);
    const hundred = Array.from({ length: 100 }, (_, i) => "T" + String(i).padStart(3, "0"));
    expect((await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: hundred })).status).toBe(200);
    expect((await call("POST", `/api/watchlists/${defaultId}/symbols`, { symbol: "ZZZ" })).status).toBe(409);
    await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: ["AAPL", "MSFT"] });
  });

  it("creates and deletes lists; refuses duplicate names, bad names, and deleting the last list", async () => {
    const c = await call("POST", "/api/watchlists", { name: "Swing" });
    expect(c.status).toBe(201);
    expect((await call("POST", "/api/watchlists", { name: "swing" })).status).toBe(409); // case-insensitive
    expect((await call("POST", "/api/watchlists", { name: "   " })).status).toBe(400);
    expect((await call("POST", "/api/watchlists", { name: "x".repeat(41) })).status).toBe(400);
    expect((await call("DELETE", `/api/watchlists/${c.json.id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/watchlists/${c.json.id}`)).status).toBe(404);
    expect((await call("DELETE", `/api/watchlists/${defaultId}`)).status).toBe(409); // the only one left
  });

  it("validates ids", async () => {
    expect((await call("GET", "/api/watchlists/abc")).status).toBe(400);
    expect((await call("GET", "/api/watchlists/1e3")).status).toBe(400);
    expect((await call("GET", "/api/watchlists/99999")).status).toBe(404);
  });

  it("the worker's view (monitoredSymbols) follows API changes immediately", async () => {
    const { monitoredSymbols } = await import("../engine/store.js");
    await call("PUT", `/api/watchlists/${defaultId}/symbols`, { symbols: ["NVDA", "AMD"] });
    expect(monitoredSymbols(db, 10).symbols).toEqual(["NVDA", "AMD"]);
  });
});

describe("alerts", () => {
  const ctx = (n: number) => ({ db, nowMs: 1_800_000_000_000 + n * 1000, cfg: mod.cfg });
  const mk = (n: number, importance: "low" | "normal" | "high", type = "move_up", symbol: string | null = "AAPL") =>
    mod.raiseAlert(ctx(n), { type, symbol, importance, dedupeKey: `t${n}`, cooldownMs: 1, title: `T${n}`, body: `B${n}`, dataLabel: "delayed" });

  beforeAll(() => {
    mk(1, "low", "news");
    mk(2, "normal", "signal");
    mk(3, "high", "position_closed");
    mk(4, "normal", "signal", "MSFT");
  });

  it("lists newest first with the fields the dashboard needs, and counts unacknowledged important alerts", async () => {
    const r = await call("GET", "/api/alerts?limit=10");
    expect(r.status).toBe(200);
    expect(r.json.alerts.map((a: { title: string }) => a.title)).toEqual(["T4", "T3", "T2", "T1"]);
    expect(r.json.alerts[0]).toMatchObject({ symbol: "MSFT", type: "signal", importance: "normal", data_label: "delayed", ai_status: "none", acknowledged_at: null });
    expect(r.json.unacknowledgedImportant).toBe(3); // low-importance news is not counted
  });

  it("filters by importance and type, paginates with beforeId", async () => {
    expect((await call("GET", "/api/alerts?importance=high")).json.alerts).toHaveLength(1);
    expect((await call("GET", "/api/alerts?type=signal")).json.alerts).toHaveLength(2);
    const first = (await call("GET", "/api/alerts?limit=2")).json.alerts;
    const next = (await call("GET", `/api/alerts?limit=2&beforeId=${first[1].id}`)).json.alerts;
    expect(next.map((a: { title: string }) => a.title)).toEqual(["T2", "T1"]);
  });

  it.each(["limit=0", "limit=201", "limit=abc", "importance=critical", "type=a%27%20OR%201%3D1%20--", "type=UPPER", "beforeId=-1", "unacked=2"])(
    "rejects invalid query %s (and nothing reaches SQL)",
    async (q) => {
      expect((await call("GET", `/api/alerts?${q}`)).status).toBe(400);
    }
  );

  it("acknowledges one alert, then all", async () => {
    const list = (await call("GET", "/api/alerts")).json.alerts;
    expect((await call("POST", `/api/alerts/${list[0].id}/ack`)).status).toBe(204);
    expect((await call("GET", "/api/alerts?unacked=1")).json.alerts).toHaveLength(3);
    expect((await call("POST", "/api/alerts/999999/ack")).status).toBe(404);
    expect((await call("POST", "/api/alerts/abc/ack")).status).toBe(400);
    const all = await call("POST", "/api/alerts/ack-all");
    expect(all.json.acknowledged).toBe(3);
    expect((await call("GET", "/api/alerts")).json.unacknowledgedImportant).toBe(0);
  });

  it("never exposes Telegram delivery internals", async () => {
    const a = (await call("GET", "/api/alerts")).json.alerts[0];
    expect(Object.keys(a)).not.toContain("telegram_error");
    expect(Object.keys(a)).not.toContain("telegram_attempts");
  });
});

describe("signals", () => {
  it("lists signals with parsed meta/verdict and filters by status", async () => {
    mod.insertSignal(db, { symbol: "AAPL", strategy: "orb", side: "LONG", entry: 100, stop: 98, target: 104, riskPerShare: 2, rewardRisk: 2, validUntilMs: 1, sessionDate: "2026-07-15", meta: { orHigh: 100 } }, 1);
    const r = await call("GET", "/api/signals");
    expect(r.json[0]).toMatchObject({ symbol: "AAPL", strategy: "orb", status: "pending", meta: { orHigh: 100 }, risk_verdict: null });
    expect((await call("GET", "/api/signals?status=pending")).json).toHaveLength(1);
    expect((await call("GET", "/api/signals?status=filled")).json).toHaveLength(0);
    expect((await call("GET", "/api/signals?status=bogus")).status).toBe(400);
  });
});

describe("paper trading", () => {
  const T = Date.now();
  let posId: number;

  it("starts flat with the configured paper cash and says it is paper", async () => {
    const a = (await call("GET", "/api/paper/account")).json;
    expect(a).toMatchObject({ mode: "paper", startingCash: 100_000, cash: 100_000, equity: 100_000, openPositions: 0, tradesToday: 0, dailyPnl: 0 });
    expect(a.limits).toMatchObject({ maxOpenPositions: 3, tradingEnabled: true });
  });

  it("reflects an open position in cash, equity, and open risk", async () => {
    posId = mod.openPosition(db, { signalId: null, symbol: "AAPL", strategy: "orb", qty: 100, fillPrice: 100, stop: 98, target: 104, riskPerShare: 2, nowMs: T, sessionDate: "2026-07-15", commission: 0 }).id;
    mod.markPosition(db, posId, 101, T);
    const a = (await call("GET", "/api/paper/account")).json;
    expect(a).toMatchObject({ cash: 90_000, openValue: 10_100, equity: 100_100, unrealizedPnl: 100, openPositions: 1 });
    expect(a.openRisk).toBe(300); // (101 - 98) * 100
    const list = (await call("GET", "/api/paper/positions?status=open")).json;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ symbol: "AAPL", status: "open", stop_price: 98 });
  });

  it("lists orders and rejects bad query values", async () => {
    expect((await call("GET", "/api/paper/orders")).json[0]).toMatchObject({ side: "BUY", kind: "entry" });
    expect((await call("GET", "/api/paper/positions?status=weird")).status).toBe(400);
    expect((await call("GET", "/api/paper/positions?limit=999")).status).toBe(400);
  });

  it("saves trade notes, with a length limit", async () => {
    expect((await call("PATCH", `/api/paper/positions/${posId}`, { notes: "good setup" })).json.notes).toBe("good setup");
    expect((await call("PATCH", `/api/paper/positions/${posId}`, { notes: "x".repeat(2001) })).status).toBe(400);
    expect((await call("PATCH", "/api/paper/positions/99999", { notes: "x" })).status).toBe(404);
    expect((await call("PATCH", `/api/paper/positions/${posId}`, { notes: "x", extra: true })).status).toBe(400);
  });

  it("refuses a manual close when there is no recent price, and closes at the last mark when there is", async () => {
    db.prepare("UPDATE paper_positions SET last_price_at = ? WHERE id = ?").run(Date.now() - 30 * 60_000, posId);
    expect((await call("POST", `/api/paper/positions/${posId}/close`)).status).toBe(409);
    expect((await call("GET", "/api/paper/positions?status=open")).json).toHaveLength(1);

    db.prepare("UPDATE paper_positions SET last_price_at = ? WHERE id = ?").run(Date.now() - 1000, posId);
    const r = await call("POST", `/api/paper/positions/${posId}/close`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "closed", exit_reason: "manual", exit_price: 101, realized_pnl: 100 });
    expect((await call("GET", "/api/paper/account")).json).toMatchObject({ cash: 100_100, openPositions: 0, allTimePnl: 100 });
    expect((await call("POST", `/api/paper/positions/${posId}/close`)).status).toBe(409); // already closed
    expect((await call("POST", "/api/paper/positions/99999/close")).status).toBe(404);
    expect((await call("POST", "/api/paper/positions/abc/close")).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE decision = 'paper_sell' AND reason = 'manual'").get()).toEqual({ c: 1 });
  });

  it("computes win/loss statistics", async () => {
    const a = (await call("GET", "/api/paper/account")).json;
    expect(a.allTime).toMatchObject({ closedTrades: 1, wins: 1, losses: 0, totalPnl: 100, winRate: 1 });
  });

  it("reset requires the exact confirmation word, restores cash, and is audited", async () => {
    for (const body of [{}, { confirm: "reset" }, { confirm: true }, { confirm: "RESET", extra: 1 }]) {
      expect((await call("POST", "/api/paper/reset", body)).status).toBe(400);
    }
    expect((await call("GET", "/api/paper/account")).json.cash).toBe(100_100); // nothing happened yet
    const r = await call("POST", "/api/paper/reset", { confirm: "RESET" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ cash: 100_000, equity: 100_000, openPositions: 0 });
    expect((await call("GET", "/api/paper/positions")).json).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE decision = 'paper_account_reset'").get()).toEqual({ c: 1 });
  });
});

describe("monitor status", () => {
  const hb = (over = {}) => ({
    pid: 4242, startedAt: Date.now() - 3_600_000, tickAt: Date.now() - 20_000, tickMs: 900, tickCount: 60, errorCount: 1, lastError: "quotes: boom", quoteFailures: 0,
    symbols: 8, eligible: 7, phase: "open", pollSeconds: 60, tradingMode: "paper", telegram: true, ai: true,
    aiUsage: { day: "2026-07-15", used: 2, limit: 10, remaining: 8 }, ...over,
  });

  it("reports the worker as NOT running when it has never written a heartbeat", async () => {
    const r = (await call("GET", "/api/monitor/status")).json;
    expect(r.worker).toMatchObject({ running: false, heartbeatAgeSec: null, tickCount: 0 });
    expect(r.mode).toBe("paper");
    expect(r.disclaimer).toMatch(/Paper trading only/);
  });

  it("reports a fresh heartbeat as running, without leaking the pid", async () => {
    mod.setWorkerState(db, "heartbeat", hb(), Date.now());
    mod.setWorkerState(db, "market_conditions", { asOf: Date.now(), regime: "risk_on", indices: [], vix: 14, note: "ok" }, Date.now());
    const r = (await call("GET", "/api/monitor/status")).json;
    expect(r.worker).toMatchObject({ running: true, tickCount: 60, monitoredSymbols: 8, eligibleSymbols: 7, phase: "open", lastError: "quotes: boom" });
    expect(r.worker.heartbeatAgeSec).toBeGreaterThanOrEqual(0);
    expect(r.notifications).toEqual({ telegram: true });
    expect(r.ai).toMatchObject({ enabled: true, limit: 10 });
    expect(r.marketConditions.regime).toBe("risk_on");
    expect(JSON.stringify(r)).not.toContain("4242");
    expect(JSON.stringify(r)).not.toMatch(/token|api[_-]?key|secret/i);
  });

  it("flags a heartbeat that has gone quiet", async () => {
    mod.setWorkerState(db, "heartbeat", hb({ tickAt: Date.now() - 3_600_000 }), Date.now());
    expect((await call("GET", "/api/monitor/status")).json.worker.running).toBe(false);
  });
});

describe("risk configuration", () => {
  it("serves the current config with defaults", async () => {
    const r = (await call("GET", "/api/risk/config")).json;
    expect(r.config.riskPerTradePct).toBe(0.5);
    expect(r.defaults.maxOpenPositions).toBe(3);
  });

  it("applies a valid partial update, persists it, and audits what changed", async () => {
    const r = await call("PUT", "/api/risk/config", { maxOpenPositions: 2, minPrice: 10 });
    expect(r.status).toBe(200);
    expect(r.json.config).toMatchObject({ maxOpenPositions: 2, minPrice: 10, riskPerTradePct: 0.5 });
    expect((await call("GET", "/api/risk/config")).json.config.maxOpenPositions).toBe(2);
    const a = db.prepare("SELECT detail FROM audit_log WHERE decision = 'risk_updated'").get() as { detail: string };
    expect(JSON.parse(a.detail).changed).toEqual({ maxOpenPositions: 2, minPrice: 10 });
  });

  it.each([
    ["risk above the hard ceiling", { riskPerTradePct: 10 }],
    ["position size above 100%", { maxPositionPct: 500 }],
    ["unknown field", { leverage: 20 }],
    ["wrong type", { maxOpenPositions: "many" }],
    ["inverted window", { entryStart: "16:00" }],
    ["array body", [1]],
  ])("rejects %s and leaves the stored config unchanged", async (_n, body) => {
    const before = (await call("GET", "/api/risk/config")).json.config;
    expect((await call("PUT", "/api/risk/config", body)).status).toBe(400);
    expect((await call("GET", "/api/risk/config")).json.config).toEqual(before);
  });

  it("supports the kill switch", async () => {
    await call("PUT", "/api/risk/config", { tradingEnabled: false });
    expect((await call("GET", "/api/paper/account")).json.limits.tradingEnabled).toBe(false);
    await call("PUT", "/api/risk/config", { tradingEnabled: true });
  });
});

describe("reports and audit", () => {
  it("lists and fetches reports", async () => {
    db.prepare("INSERT INTO reports (kind, period_key, created_at, title, body, data) VALUES ('daily', '2026-07-15', 1, 'Daily report 2026-07-15', 'body text', '{\"equity\": 1}')").run();
    const list = (await call("GET", "/api/reports")).json;
    expect(list).toEqual([expect.objectContaining({ kind: "daily", period_key: "2026-07-15", title: "Daily report 2026-07-15" })]);
    expect(Object.keys(list[0])).not.toContain("body"); // list is light; the body is fetched on demand
    const one = (await call("GET", `/api/reports/${list[0].id}`)).json;
    expect(one).toMatchObject({ body: "body text", data: { equity: 1 } });
    expect((await call("GET", "/api/reports/999")).status).toBe(404);
    expect((await call("GET", "/api/reports/x")).status).toBe(400);
    expect((await call("GET", "/api/reports?kind=monthly")).status).toBe(400);
  });

  it("lists audit entries with parsed detail, newest first, with validated filters", async () => {
    mod.audit(db, { kind: "risk", symbol: "AAPL", decision: "blocked", reason: "max_open_positions", detail: { a: 1 } }, 5000);
    mod.audit(db, { kind: "data", symbol: "MSFT", decision: "rejected", reason: "stale" }, 6000);
    const all = (await call("GET", "/api/audit?limit=200")).json;
    expect(all[0].id).toBeGreaterThan(all[all.length - 1].id);
    const risk = (await call("GET", "/api/audit?kind=risk&symbol=aapl")).json;
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({ decision: "blocked", reason: "max_open_positions", detail: { a: 1 } });
    expect((await call("GET", "/api/audit?kind=bogus")).status).toBe(400);
    expect((await call("GET", "/api/audit?symbol=AAPL%27%3B--")).status).toBe(400);
    expect((await call("GET", "/api/audit?limit=0")).status).toBe(400);
  });
});
