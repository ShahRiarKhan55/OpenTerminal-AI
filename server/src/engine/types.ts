/** One OHLCV bar. `time` is the bar's START, epoch seconds (UTC). */
export type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

export type StrategyId = "orb" | "breakout20";

/** A long-only trade idea. Prices are the PLAN; fills are decided later by entry rules. */
export type SignalCandidate = {
  symbol: string;
  strategy: StrategyId;
  side: "LONG";
  entry: number;
  stop: number;
  target: number;
  riskPerShare: number;
  rewardRisk: number;
  validUntilMs: number;
  sessionDate: string;
  meta: Record<string, number | string | boolean>;
};

export type DetectResult = { ok: true; signal: SignalCandidate } | { ok: false; skip: string };
