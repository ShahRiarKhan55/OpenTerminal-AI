import { etClock, parseHm } from "../marketdata/time.js";
import type { MarketPhase } from "../marketdata/types.js";
import type { RiskConfig } from "./risk.js";

/** Paper fills are deliberately pessimistic: always slip against us. */
export function applySlippage(price: number, side: "BUY" | "SELL", bps: number): number {
  const f = bps / 10_000;
  return side === "BUY" ? price * (1 + f) : price * (1 - f);
}

export type EntryDecision =
  | { action: "fill"; refPrice: number }
  | { action: "wait" }
  | { action: "expire" }
  | { action: "invalidate" }
  | { action: "skip_chase" };

/**
 * Where is a pending long signal, given the latest FRESH price?
 *  expire      validity window elapsed
 *  invalidate  price fell to/below the stop before we ever got in
 *  wait        below the entry level (breakout not (re)confirmed)
 *  skip_chase  already more than maxChaseR past entry: the plan's reward/risk is gone
 *  fill        at/above entry and within the chase limit
 */
export function evaluateEntry(
  sig: { entry: number; stop: number; riskPerShare: number; validUntilMs: number },
  price: number,
  nowMs: number,
  cfg: Pick<RiskConfig, "maxChaseR">
): EntryDecision {
  if (nowMs > sig.validUntilMs) return { action: "expire" };
  if (price <= sig.stop) return { action: "invalidate" };
  if (price < sig.entry) return { action: "wait" };
  if (price > sig.entry + cfg.maxChaseR * sig.riskPerShare) return { action: "skip_chase" };
  return { action: "fill", refPrice: price };
}

export type ExitReason = "stop" | "target" | "time_stop" | "session_end";

export type ExitDecision =
  | { action: "hold"; newStop?: number }
  | { action: "exit"; reason: ExitReason; fill: number };

/**
 * Exit rules for an open long, evaluated on a FRESH price only:
 *  1. price <= stop           -> exit at the (slipped) observed price, never better than the stop
 *  2. price >= target         -> exit at the target (limit order, no price improvement assumed)
 *  3. position from a prior session, or session no longer open -> flatten ("session_end")
 *  4. ET time >= flatBy       -> flatten ("time_stop")
 *  5. +breakevenAtR reached   -> raise the stop to entry (never lowers it)
 * Day-trading discipline: nothing is carried overnight.
 */
export function evaluateExit(
  pos: { entryPrice: number; stopPrice: number; targetPrice: number; riskPerShare: number; sessionDate: string },
  price: number,
  nowMs: number,
  phase: MarketPhase,
  cfg: Pick<RiskConfig, "flatBy" | "breakevenAtR" | "slippageBps">
): ExitDecision {
  const sell = (p: number) => applySlippage(p, "SELL", cfg.slippageBps);
  if (price <= pos.stopPrice) return { action: "exit", reason: "stop", fill: sell(price) };
  if (price >= pos.targetPrice) return { action: "exit", reason: "target", fill: pos.targetPrice };

  const clock = etClock(nowMs);
  if (pos.sessionDate < clock.dateKey || phase === "post" || phase === "closed") {
    return { action: "exit", reason: "session_end", fill: sell(price) };
  }
  if (clock.minutes >= parseHm(cfg.flatBy)!) return { action: "exit", reason: "time_stop", fill: sell(price) };

  if (cfg.breakevenAtR > 0 && pos.stopPrice < pos.entryPrice && price >= pos.entryPrice + cfg.breakevenAtR * pos.riskPerShare) {
    return { action: "hold", newStop: pos.entryPrice };
  }
  return { action: "hold" };
}
