import { describe, expect, it } from "vitest";
import { DEFAULT_RISK } from "./risk.js";
import { makeDb } from "../test-helpers.js";
import {
  getSetting, getWorkerState, insertSignal, loadRiskConfig, monitoredSymbols, pendingSignals, saveRiskConfig, setSetting,
  setSignalStatus, setWorkerState, SymbolSchema,
} from "./store.js";
import type { SignalCandidate } from "./types.js";

const cand = (over: Partial<SignalCandidate> = {}): SignalCandidate => ({
  symbol: "ABC", strategy: "orb", side: "LONG", entry: 100, stop: 98, target: 104, riskPerShare: 2, rewardRisk: 2, validUntilMs: 5000,
  sessionDate: "2026-07-15", meta: { a: 1 }, ...over,
});

describe("risk config persistence", () => {
  it("defaults when nothing is stored", () => {
    expect(loadRiskConfig(makeDb())).toEqual({ config: DEFAULT_RISK, fellBack: false });
  });

  it("saves a valid partial update and merges it over the current config", () => {
    const db = makeDb();
    const r = saveRiskConfig(db, { maxOpenPositions: 5 }, 1);
    expect(r).toMatchObject({ ok: true });
    saveRiskConfig(db, { minPrice: 10 }, 2);
    expect(loadRiskConfig(db).config).toEqual({ ...DEFAULT_RISK, maxOpenPositions: 5, minPrice: 10 });
  });

  it.each([
    ["above the safety ceiling", { riskPerTradePct: 50 }],
    ["unknown key", { leverage: 10 }],
    ["wrong type", { tradingEnabled: "yes" }],
    ["inverted window", { entryStart: "16:00" }],
    ["not an object", [1, 2]],
    ["null", null],
  ])("rejects an update %s and stores nothing", (_n, patch) => {
    const db = makeDb();
    const r = saveRiskConfig(db, patch, 1);
    expect(r.ok).toBe(false);
    expect(getSetting(db, "risk_config")).toBeNull();
  });

  it("falls back to safe defaults when stored JSON is corrupt or out of bounds", () => {
    const db = makeDb();
    setSetting(db, "risk_config", "{not json", 1);
    expect(loadRiskConfig(db)).toEqual({ config: DEFAULT_RISK, fellBack: true });
    setSetting(db, "risk_config", JSON.stringify({ riskPerTradePct: 99 }), 2);
    expect(loadRiskConfig(db)).toEqual({ config: DEFAULT_RISK, fellBack: true });
  });

  it("can disable trading (kill switch) and persists it", () => {
    const db = makeDb();
    saveRiskConfig(db, { tradingEnabled: false }, 1);
    expect(loadRiskConfig(db).config.tradingEnabled).toBe(false);
  });
});

describe("worker state", () => {
  it("round-trips JSON with its timestamp and overwrites", () => {
    const db = makeDb();
    setWorkerState(db, "heartbeat", { n: 1 }, 100);
    setWorkerState(db, "heartbeat", { n: 2 }, 200);
    expect(getWorkerState(db, "heartbeat")).toEqual({ value: { n: 2 }, updatedAt: 200 });
    expect(getWorkerState(db, "missing")).toBeNull();
  });
});

describe("SymbolSchema", () => {
  it.each(["AAPL", "aapl", " msft ", "BRK.B", "BF-B", "A", "SPY"])("accepts %j", (s) => {
    expect(SymbolSchema.safeParse(s).success).toBe(true);
  });
  it("normalizes to upper case and trims", () => {
    expect(SymbolSchema.parse(" brk.b ")).toBe("BRK.B");
    expect(SymbolSchema.parse("AAPL\n")).toBe("AAPL"); // surrounding whitespace is stripped, not rejected
  });
  it.each(["", "AAPL$", "A B", "../etc/passwd", "TOOLONGSYMBOL", "1ABC", "AA,PL", "<script>", "AA\nPL", "AAPL;DROP", "^VIX"])("rejects %j", (s) => {
    expect(SymbolSchema.safeParse(s).success).toBe(false);
  });
});

describe("monitoredSymbols", () => {
  it("de-duplicates across watchlists, keeps a stable order, and caps with a truncation flag", () => {
    const db = makeDb();
    const a = Number(db.prepare("INSERT INTO watchlists (name) VALUES ('A')").run().lastInsertRowid);
    const b = Number(db.prepare("INSERT INTO watchlists (name) VALUES ('B')").run().lastInsertRowid);
    const ins = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
    ["AAPL", "MSFT", "NVDA"].forEach((s, i) => ins.run(a, s, i));
    ["MSFT", "TSLA"].forEach((s, i) => ins.run(b, s, i));
    expect(monitoredSymbols(db, 10)).toEqual({ symbols: ["AAPL", "MSFT", "NVDA", "TSLA"], truncated: false });
    expect(monitoredSymbols(db, 2)).toEqual({ symbols: ["AAPL", "MSFT"], truncated: true });
  });
  it("is empty with no watchlists", () => {
    expect(monitoredSymbols(makeDb(), 10)).toEqual({ symbols: [], truncated: false });
  });
});

describe("signals", () => {
  it("de-duplicates per strategy/symbol/session", () => {
    const db = makeDb();
    expect(insertSignal(db, cand(), 1)).toMatchObject({ status: "pending", symbol: "ABC", meta: '{"a":1}' });
    expect(insertSignal(db, cand(), 2)).toBeNull();
    expect(insertSignal(db, cand({ strategy: "breakout20" }), 3)).not.toBeNull();
    expect(insertSignal(db, cand({ sessionDate: "2026-07-16" }), 4)).not.toBeNull();
    expect(insertSignal(db, cand({ symbol: "XYZ" }), 5)).not.toBeNull();
  });

  it("updates status with reason and verdict, and pendingSignals only lists pending ones", () => {
    const db = makeDb();
    const s = insertSignal(db, cand(), 1)!;
    insertSignal(db, cand({ symbol: "XYZ" }), 1);
    expect(pendingSignals(db)).toHaveLength(2);
    setSignalStatus(db, s.id, "blocked", 9, { reason: "max_open_positions", verdict: { pass: false } });
    const row = db.prepare("SELECT status, reason, risk_verdict, updated_at FROM signals WHERE id = ?").get(s.id);
    expect(row).toEqual({ status: "blocked", reason: "max_open_positions", risk_verdict: '{"pass":false}', updated_at: 9 });
    expect(pendingSignals(db).map((r) => r.symbol)).toEqual(["XYZ"]);
  });
});
