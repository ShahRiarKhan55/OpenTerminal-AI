import { z } from "zod";
import { etClock, parseHm } from "../marketdata/time.js";

const hm = z.string().refine((v) => parseHm(v) !== null, "must be HH:MM (24h, America/New_York)");

/**
 * Risk limits. Every field is hard-bounded: even a mistaken or malicious
 * config update cannot raise risk past these ceilings (the bounds, not the
 * defaults, are the safety boundary).
 */
export const RiskConfigSchema = z
  .object({
    tradingEnabled: z.boolean(),
    riskPerTradePct: z.number().min(0.05).max(2),
    maxPositionPct: z.number().min(1).max(100),
    maxOpenPositions: z.number().int().min(1).max(20),
    maxDailyLossPct: z.number().min(0.25).max(10),
    maxTradesPerDay: z.number().int().min(1).max(50),
    minRewardRisk: z.number().min(1).max(10),
    entryStart: hm,
    entryEnd: hm,
    flatBy: hm,
    minPrice: z.number().min(0.5).max(1000),
    maxSpreadPct: z.number().min(0.01).max(5),
    minAvgVolume: z.number().min(0).max(1e9),
    cooldownAfterStopMin: z.number().int().min(0).max(1440),
    maxChaseR: z.number().min(0).max(2),
    breakevenAtR: z.number().min(0).max(5),
    slippageBps: z.number().min(0).max(100),
    commissionPerOrder: z.number().min(0).max(50),
  })
  .strict()
  .refine((c) => parseHm(c.entryStart)! < parseHm(c.entryEnd)! && parseHm(c.entryEnd)! < parseHm(c.flatBy)!, {
    message: "entryStart < entryEnd < flatBy is required",
    path: ["entryEnd"],
  });

export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const DEFAULT_RISK: RiskConfig = {
  tradingEnabled: true,
  riskPerTradePct: 0.5,
  maxPositionPct: 25,
  maxOpenPositions: 3,
  maxDailyLossPct: 2,
  maxTradesPerDay: 6,
  minRewardRisk: 1.5,
  entryStart: "09:45",
  entryEnd: "15:30",
  flatBy: "15:55",
  minPrice: 5,
  maxSpreadPct: 0.5,
  minAvgVolume: 500_000,
  cooldownAfterStopMin: 60,
  maxChaseR: 0.5,
  breakevenAtR: 1,
  slippageBps: 5,
  commissionPerOrder: 0,
};

export type RiskReason =
  | "trading_disabled"
  | "invalid_levels"
  | "daily_loss_limit"
  | "max_trades_per_day"
  | "max_open_positions"
  | "already_open_symbol"
  | "symbol_cooldown"
  | "outside_entry_window"
  | "reward_risk_too_low"
  | "price_too_low"
  | "spread_too_wide"
  | "avg_volume_too_low"
  | "insufficient_cash"
  | "size_zero";

export type RiskState = {
  equity: number;
  cash: number;
  openSymbols: string[];
  realizedToday: number;
  unrealizedOpen: number;
  tradesToday: number;
  /** epoch ms of the most recent stop-out per symbol */
  lastStopOutAt: Record<string, number>;
};

export type RiskVerdict = {
  pass: boolean;
  reasons: RiskReason[];
  qty: number;
  riskAmount: number;
  notional: number;
  rewardRiskAtFill: number | null;
};

export type RiskInput = {
  symbol: string;
  stop: number;
  target: number;
  /** Price we expect to fill at (current price plus slippage), not the plan level. */
  fillPrice: number;
  bid?: number | null;
  ask?: number | null;
  avgVolume?: number | null;
};

/**
 * Pure risk gate + position sizer. Collects EVERY failing reason (not just the
 * first) so the audit log shows the whole picture. Sizing uses the FILL price,
 * so chasing past the planned entry shrinks the position instead of silently
 * inflating risk.
 */
export function checkRisk(input: RiskInput, state: RiskState, cfg: RiskConfig, nowMs: number): RiskVerdict {
  const reasons: RiskReason[] = [];
  const { fillPrice, stop, target } = input;
  const finite = [fillPrice, stop, target].every((n) => Number.isFinite(n));
  const risk = fillPrice - stop;
  const valid = finite && stop > 0 && fillPrice > stop && target > fillPrice;
  if (!valid) reasons.push("invalid_levels");

  if (!cfg.tradingEnabled) reasons.push("trading_disabled");

  const pnlToday = state.realizedToday + state.unrealizedOpen;
  const startEquity = state.equity - pnlToday;
  if (startEquity > 0 && pnlToday <= -(startEquity * cfg.maxDailyLossPct) / 100) reasons.push("daily_loss_limit");
  if (state.tradesToday >= cfg.maxTradesPerDay) reasons.push("max_trades_per_day");
  if (state.openSymbols.length >= cfg.maxOpenPositions) reasons.push("max_open_positions");
  if (state.openSymbols.includes(input.symbol)) reasons.push("already_open_symbol");
  const lastStop = state.lastStopOutAt[input.symbol];
  if (lastStop !== undefined && nowMs - lastStop < cfg.cooldownAfterStopMin * 60_000) reasons.push("symbol_cooldown");

  const clock = etClock(nowMs);
  const start = parseHm(cfg.entryStart)!;
  const end = parseHm(cfg.entryEnd)!;
  if (!clock.isWeekday || clock.minutes < start || clock.minutes >= end) reasons.push("outside_entry_window");

  if (Number.isFinite(fillPrice) && fillPrice < cfg.minPrice) reasons.push("price_too_low");
  if (input.bid && input.ask && input.bid > 0 && input.ask >= input.bid) {
    const spreadPct = ((input.ask - input.bid) / ((input.ask + input.bid) / 2)) * 100;
    if (spreadPct > cfg.maxSpreadPct) reasons.push("spread_too_wide");
  }
  // Unknown average volume is not penalized (providers don't always report it); a KNOWN low one is.
  if (input.avgVolume !== null && input.avgVolume !== undefined && input.avgVolume < cfg.minAvgVolume) reasons.push("avg_volume_too_low");

  const rewardRiskAtFill = valid ? (target - fillPrice) / risk : null;
  if (rewardRiskAtFill !== null && rewardRiskAtFill < cfg.minRewardRisk) reasons.push("reward_risk_too_low");

  let qty = 0;
  let riskAmount = 0;
  if (valid) {
    const fee = cfg.commissionPerOrder;
    const byRisk = Math.floor((state.equity * cfg.riskPerTradePct) / 100 / risk);
    const byNotional = Math.floor((state.equity * cfg.maxPositionPct) / 100 / fillPrice);
    const byCash = Math.floor(Math.max(0, state.cash - fee) / fillPrice);
    qty = Math.max(0, Math.min(byRisk, byNotional, byCash));
    if (byCash < 1) reasons.push("insufficient_cash");
    else if (qty < 1) reasons.push("size_zero");
    riskAmount = qty * risk;
  }

  return {
    pass: reasons.length === 0 && qty >= 1,
    reasons: [...new Set(reasons)],
    qty,
    riskAmount,
    notional: qty * (Number.isFinite(fillPrice) ? fillPrice : 0),
    rewardRiskAtFill,
  };
}
