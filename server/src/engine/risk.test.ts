import { describe, expect, it } from "vitest";
import { easternToEpochMs } from "../marketdata/time.js";
import { checkRisk, DEFAULT_RISK, RiskConfigSchema, type RiskState } from "./risk.js";

const et = (h: number, m: number, day = 15) => easternToEpochMs(2026, 6, day, h, m)!; // Wed 2026-07-15
const NOW = et(10, 30);

const state = (over: Partial<RiskState> = {}): RiskState => ({
  equity: 100_000, cash: 100_000, openSymbols: [], realizedToday: 0, unrealizedOpen: 0, tradesToday: 0, lastStopOutAt: {}, ...over,
});
const input = (over = {}) => ({ symbol: "ABC", fillPrice: 100, stop: 90, target: 120, ...over });

describe("checkRisk: pass and sizing", () => {
  it("passes a clean setup and sizes by risk: 0.5% of 100k = 500 / 10 per share = 50 shares", () => {
    const v = checkRisk(input(), state(), DEFAULT_RISK, NOW);
    expect(v).toMatchObject({ pass: true, reasons: [], qty: 50, riskAmount: 500, notional: 5000, rewardRiskAtFill: 2 });
  });

  it("is capped by max position size: 25% of 100k = 25k / 100 = 250 shares", () => {
    // tight stop -> risk-based size (500/0.5 = 1000) exceeds the notional cap
    const v = checkRisk(input({ stop: 99.5, target: 101.5 }), state(), DEFAULT_RISK, NOW);
    expect(v.qty).toBe(250);
    expect(v.pass).toBe(true);
    expect(v.riskAmount).toBeCloseTo(125, 10);
  });

  it("is capped by available cash", () => {
    const v = checkRisk(input({ stop: 99.5, target: 101.5 }), state({ cash: 1000 }), DEFAULT_RISK, NOW);
    expect(v.qty).toBe(10);
  });

  it("sizes from the FILL price, so a chased entry takes fewer shares", () => {
    const planned = checkRisk(input({ fillPrice: 100, stop: 90, target: 130 }), state(), DEFAULT_RISK, NOW);
    const chased = checkRisk(input({ fillPrice: 104, stop: 90, target: 130 }), state(), DEFAULT_RISK, NOW);
    expect(planned.qty).toBe(50); // 500 / 10
    expect(chased.qty).toBe(35); // 500 / 14 = 35.7 -> 35
    expect(chased.riskAmount).toBeLessThanOrEqual(500);
  });

  it("never risks more than the configured amount", () => {
    for (const fill of [37.3, 101.17, 250.55, 999.99]) {
      const v = checkRisk({ symbol: "A", fillPrice: fill, stop: fill * 0.97, target: fill * 1.1 }, state(), DEFAULT_RISK, NOW);
      expect(v.riskAmount).toBeLessThanOrEqual(500 + 1e-9);
      expect(v.notional).toBeLessThanOrEqual(25_000 + 1e-9);
    }
  });

  it("returns whole shares only", () => {
    const v = checkRisk(input({ fillPrice: 33.33, stop: 32.01, target: 36 }), state(), DEFAULT_RISK, NOW);
    expect(Number.isInteger(v.qty)).toBe(true);
  });
});

describe("checkRisk: each gate", () => {
  const reasons = (inp = input(), st = state(), cfg = DEFAULT_RISK, now = NOW) => checkRisk(inp, st, cfg, now).reasons;

  it("trading_disabled (kill switch)", () => {
    expect(reasons(input(), state(), { ...DEFAULT_RISK, tradingEnabled: false })).toContain("trading_disabled");
  });

  it("daily_loss_limit counts realized AND unrealized, at the boundary", () => {
    // equity 98k after -2k realized => start 100k, limit 2% = 2000
    expect(reasons(input(), state({ equity: 98_000, realizedToday: -2000 }))).toContain("daily_loss_limit");
    expect(reasons(input(), state({ equity: 98_001, realizedToday: -1999 }))).not.toContain("daily_loss_limit");
    expect(reasons(input(), state({ equity: 98_000, realizedToday: -1000, unrealizedOpen: -1000 }))).toContain("daily_loss_limit");
  });

  it("max_trades_per_day", () => {
    expect(reasons(input(), state({ tradesToday: 6 }))).toContain("max_trades_per_day");
    expect(reasons(input(), state({ tradesToday: 5 }))).not.toContain("max_trades_per_day");
  });

  it("max_open_positions and already_open_symbol", () => {
    expect(reasons(input(), state({ openSymbols: ["A", "B", "C"] }))).toContain("max_open_positions");
    expect(reasons(input(), state({ openSymbols: ["ABC"] }))).toContain("already_open_symbol");
    expect(reasons(input(), state({ openSymbols: ["A", "B"] }))).toEqual([]);
  });

  it("symbol_cooldown after a stop-out", () => {
    expect(reasons(input(), state({ lastStopOutAt: { ABC: NOW - 30 * 60_000 } }))).toContain("symbol_cooldown");
    expect(reasons(input(), state({ lastStopOutAt: { ABC: NOW - 61 * 60_000 } }))).not.toContain("symbol_cooldown");
    expect(reasons(input(), state({ lastStopOutAt: { OTHER: NOW - 1000 } }))).not.toContain("symbol_cooldown");
  });

  it("outside_entry_window at both edges, and on weekends", () => {
    expect(reasons(input(), state(), DEFAULT_RISK, et(9, 44))).toContain("outside_entry_window");
    expect(reasons(input(), state(), DEFAULT_RISK, et(9, 45))).not.toContain("outside_entry_window");
    expect(reasons(input(), state(), DEFAULT_RISK, et(15, 29))).not.toContain("outside_entry_window");
    expect(reasons(input(), state(), DEFAULT_RISK, et(15, 30))).toContain("outside_entry_window");
    expect(reasons(input(), state(), DEFAULT_RISK, easternToEpochMs(2026, 6, 18, 10, 30)!)).toContain("outside_entry_window"); // Saturday
  });

  it("reward_risk_too_low evaluated at the fill price", () => {
    expect(reasons(input({ target: 112 }))).toContain("reward_risk_too_low"); // 12/10 = 1.2 < 1.5
    expect(reasons(input({ target: 115 }))).not.toContain("reward_risk_too_low"); // 1.5 exactly passes
  });

  it("price_too_low", () => {
    expect(reasons(input({ fillPrice: 4.9, stop: 4.5, target: 6 }))).toContain("price_too_low");
  });

  it("spread_too_wide only when bid/ask are known", () => {
    expect(reasons(input({ bid: 99, ask: 100 }))).toContain("spread_too_wide");
    expect(reasons(input({ bid: 99.97, ask: 100.0 }))).not.toContain("spread_too_wide");
    expect(reasons(input({ bid: null, ask: null }))).not.toContain("spread_too_wide");
    expect(reasons(input({ bid: 0, ask: 100 }))).not.toContain("spread_too_wide");
  });

  it("avg_volume_too_low only when the average is known", () => {
    expect(reasons(input({ avgVolume: 100_000 }))).toContain("avg_volume_too_low");
    expect(reasons(input({ avgVolume: 5_000_000 }))).not.toContain("avg_volume_too_low");
    expect(reasons(input({ avgVolume: null }))).not.toContain("avg_volume_too_low");
  });

  it("insufficient_cash vs size_zero", () => {
    expect(reasons(input(), state({ cash: 50 }))).toContain("insufficient_cash");
    const tiny = checkRisk(input({ stop: 10, target: 300 }), state({ equity: 1000, cash: 1000 }), DEFAULT_RISK, NOW);
    expect(tiny.reasons).toContain("size_zero"); // 5 / 90 per share rounds to 0 shares
    expect(tiny.pass).toBe(false);
  });

  it.each([
    ["stop above fill", { stop: 101 }],
    ["stop equal to fill", { stop: 100 }],
    ["target below fill", { target: 99 }],
    ["NaN fill", { fillPrice: NaN }],
    ["zero stop", { stop: 0 }],
    ["negative stop", { stop: -5 }],
  ])("invalid_levels: %s", (_n, over) => {
    const v = checkRisk(input(over), state(), DEFAULT_RISK, NOW);
    expect(v.reasons).toContain("invalid_levels");
    expect(v.pass).toBe(false);
    expect(v.qty).toBe(0);
  });

  it("reports ALL failing reasons together", () => {
    const v = checkRisk(input({ fillPrice: 4, stop: 3, target: 4.5 }), state({ tradesToday: 9, openSymbols: ["ABC"] }), DEFAULT_RISK, et(16, 30));
    expect(v.pass).toBe(false);
    expect(v.reasons).toEqual(expect.arrayContaining(["max_trades_per_day", "already_open_symbol", "outside_entry_window", "price_too_low", "reward_risk_too_low"]));
  });
});

describe("RiskConfigSchema (the safety boundary)", () => {
  it("accepts the defaults", () => {
    expect(RiskConfigSchema.safeParse(DEFAULT_RISK).success).toBe(true);
  });
  it.each([
    ["risk per trade above the ceiling", { riskPerTradePct: 5 }],
    ["risk per trade zero", { riskPerTradePct: 0 }],
    ["position above 100%", { maxPositionPct: 150 }],
    ["daily loss above 10%", { maxDailyLossPct: 50 }],
    ["negative slippage", { slippageBps: -1 }],
    ["huge open positions", { maxOpenPositions: 500 }],
    ["fractional position cap", { maxOpenPositions: 2.5 }],
    ["malformed time", { entryStart: "9:45" }],
    ["entry window inverted", { entryStart: "15:40", entryEnd: "15:30" }],
    ["flat-by before entry end", { flatBy: "15:00" }],
    ["unknown key", { brokerApiKey: "x" }],
    ["string for number", { riskPerTradePct: "0.5" }],
  ])("rejects %s", (_n, over) => {
    expect(RiskConfigSchema.safeParse({ ...DEFAULT_RISK, ...over }).success).toBe(false);
  });
});
