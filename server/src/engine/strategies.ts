import { easternToEpochMs, etClock } from "../marketdata/time.js";
import { atr, avgVolume, highest, sma, vwap } from "./indicators.js";
import type { Bar, DetectResult } from "./types.js";

/** Regular US equity session in minutes since ET midnight. */
export const SESSION_OPEN_MIN = 9 * 60 + 30;
export const SESSION_CLOSE_MIN = 16 * 60;
export const SESSION_LENGTH_MIN = SESSION_CLOSE_MIN - SESSION_OPEN_MIN;
const FIVE_MIN_SEC = 300;

export type OrbParams = {
  /** Length of the opening range, in minutes (multiple of 5). */
  orMinutes: number;
  rewardRisk: number;
  stopMode: "mid" | "low";
  minRangePct: number;
  maxRangePct: number;
  /** Breakout bar volume must be at least this multiple of the average opening-range bar. */
  volMult: number;
  /** How long after the breakout bar closes the signal stays actionable. */
  validMinutes: number;
};

export const DEFAULT_ORB: OrbParams = {
  orMinutes: 30,
  rewardRisk: 2,
  stopMode: "mid",
  minRangePct: 0.3,
  maxRangePct: 4,
  volMult: 1.2,
  validMinutes: 20,
};

const skip = (reason: string): DetectResult => ({ ok: false, skip: reason });

/**
 * Opening Range Breakout (long only), on CLOSED 5-minute bars of the current
 * ET session:
 *   1. The opening range is the high/low of the first `orMinutes`.
 *   2. The FIRST post-range bar to close above the range high is the breakout;
 *      a signal exists only while that bar is the most recently closed one
 *      (a missed breakout is not chased).
 *   3. It must close above VWAP on volume >= volMult x the average range bar.
 * Entry = range high, stop = range midpoint (or low), target = entry + R x risk.
 * Bars that have not closed yet are ignored, so the in-progress bar can never
 * trigger anything.
 */
export function detectOrb(input: { symbol: string; bars: Bar[]; nowMs: number; params?: Partial<OrbParams> }): DetectResult {
  const p = { ...DEFAULT_ORB, ...input.params };
  if (!Number.isInteger(p.orMinutes / 5) || p.orMinutes < 5) return skip("invalid_params");
  const today = etClock(input.nowMs);
  if (!today.isWeekday) return skip("not_a_trading_day");

  const session = input.bars
    .filter((b) => {
      const c = etClock(b.time * 1000);
      return c.dateKey === today.dateKey && c.minutes >= SESSION_OPEN_MIN && c.minutes < SESSION_CLOSE_MIN;
    })
    .sort((a, b) => a.time - b.time);
  const closed = session.filter((b) => (b.time + FIVE_MIN_SEC) * 1000 <= input.nowMs);
  if (closed.length === 0) return skip("no_closed_bars");

  const minuteOf = (b: Bar) => etClock(b.time * 1000).minutes;
  const orEnd = SESSION_OPEN_MIN + p.orMinutes;
  const orBars = closed.filter((b) => minuteOf(b) < orEnd);
  if (orBars.length < p.orMinutes / 5) return skip("opening_range_incomplete");
  const post = closed.filter((b) => minuteOf(b) >= orEnd);
  if (post.length === 0) return skip("no_post_range_bars");

  const orHigh = Math.max(...orBars.map((b) => b.high));
  const orLow = Math.min(...orBars.map((b) => b.low));
  if (!(orHigh > orLow) || !(orLow > 0)) return skip("invalid_range");
  const rangePct = ((orHigh - orLow) / orLow) * 100;
  if (rangePct < p.minRangePct || rangePct > p.maxRangePct) return skip("range_out_of_bounds");

  const last = post[post.length - 1];
  if (post.slice(0, -1).some((b) => b.close > orHigh)) return skip("breakout_already_happened");
  if (!(last.close > orHigh)) return skip("no_breakout");

  const avgOrVol = orBars.reduce((s, b) => s + b.volume, 0) / orBars.length;
  if (!(avgOrVol > 0) || last.volume < p.volMult * avgOrVol) return skip("low_volume");
  const sessionVwap = vwap(closed);
  if (sessionVwap === null || !(last.close > sessionVwap)) return skip("below_vwap");

  const entry = orHigh;
  const stop = p.stopMode === "low" ? orLow : (orHigh + orLow) / 2;
  const risk = entry - stop;
  if (!(risk > 0) || risk / entry < 0.001) return skip("risk_too_small");

  return {
    ok: true,
    signal: {
      symbol: input.symbol,
      strategy: "orb",
      side: "LONG",
      entry,
      stop,
      target: entry + p.rewardRisk * risk,
      riskPerShare: risk,
      rewardRisk: p.rewardRisk,
      validUntilMs: (last.time + FIVE_MIN_SEC) * 1000 + p.validMinutes * 60_000,
      sessionDate: today.dateKey,
      meta: {
        orHigh,
        orLow,
        rangePct: Number(rangePct.toFixed(3)),
        vwap: Number(sessionVwap.toFixed(4)),
        breakoutBarTime: last.time,
        volRatio: Number((last.volume / avgOrVol).toFixed(2)),
      },
    },
  };
}

export type Breakout20Params = {
  lookback: number;
  trendSma: number;
  atrPeriod: number;
  atrMult: number;
  rewardRisk: number;
  /** Reject if the stop would be farther than this % below entry. */
  maxStopPct: number;
  /** Today's volume must be at least this multiple of the time-of-day-adjusted average. */
  volMult: number;
  /** Ignore volume confirmation until this fraction of the session has elapsed. */
  minElapsed: number;
  /** Signal stays valid until this ET minute-of-day. */
  validUntilMinute: number;
};

export const DEFAULT_BREAKOUT20: Breakout20Params = {
  lookback: 20,
  trendSma: 50,
  atrPeriod: 14,
  atrMult: 1.5,
  rewardRisk: 2,
  maxStopPct: 6,
  volMult: 1.2,
  minElapsed: 0.15,
  validUntilMinute: 15 * 60 + 30,
};

const barDate = (b: Bar) => new Date(b.time * 1000).toISOString().slice(0, 10);

/**
 * 20-day high breakout (long only) on completed daily bars plus the live quote:
 * price trades above the highest high of the prior `lookback` completed days,
 * above its 50-day SMA, with volume running above its time-of-day-adjusted
 * average. Stop = entry - atrMult x ATR(14); target = entry + R x risk.
 */
export function detectBreakout20(input: {
  symbol: string;
  daily: Bar[];
  price: number;
  volumeToday: number | null;
  nowMs: number;
  params?: Partial<Breakout20Params>;
}): DetectResult {
  const p = { ...DEFAULT_BREAKOUT20, ...input.params };
  const today = etClock(input.nowMs);
  if (!today.isWeekday) return skip("not_a_trading_day");
  if (!Number.isFinite(input.price) || input.price <= 0) return skip("invalid_price");

  // Completed days only: the in-progress daily bar must not contaminate the lookback.
  const done = input.daily.filter((b) => barDate(b) < today.dateKey).sort((a, b) => a.time - b.time);
  if (done.length < p.trendSma + 1) return skip("insufficient_history");

  const level = highest(done, p.lookback);
  const trend = sma(done.map((b) => b.close), p.trendSma);
  const a = atr(done, p.atrPeriod);
  const avgVol = avgVolume(done, p.lookback);
  if (level === null || trend === null || a === null || avgVol === null || !(a > 0) || !(avgVol > 0)) return skip("insufficient_history");

  if (!(input.price > level)) return skip("no_breakout");
  if (!(input.price > trend)) return skip("below_trend");

  const elapsed = Math.min(1, Math.max(0, (today.minutes - SESSION_OPEN_MIN) / SESSION_LENGTH_MIN));
  if (elapsed < p.minElapsed) return skip("too_early_for_volume");
  if (input.volumeToday === null || !Number.isFinite(input.volumeToday)) return skip("no_volume");
  if (input.volumeToday < p.volMult * avgVol * elapsed) return skip("low_volume");

  const entry = level;
  const risk = p.atrMult * a;
  const stop = entry - risk;
  if (!(stop > 0) || (risk / entry) * 100 > p.maxStopPct) return skip("stop_too_wide");
  if (risk / entry < 0.001) return skip("risk_too_small");

  const [y, m, d] = today.dateKey.split("-").map(Number);
  const validUntil = easternToEpochMs(y, m - 1, d, Math.floor(p.validUntilMinute / 60), p.validUntilMinute % 60);
  if (validUntil === null) return skip("invalid_params");

  return {
    ok: true,
    signal: {
      symbol: input.symbol,
      strategy: "breakout20",
      side: "LONG",
      entry,
      stop,
      target: entry + p.rewardRisk * risk,
      riskPerShare: risk,
      rewardRisk: p.rewardRisk,
      validUntilMs: validUntil,
      sessionDate: today.dateKey,
      meta: {
        level20: level,
        sma50: Number(trend.toFixed(4)),
        atr14: Number(a.toFixed(4)),
        relVolume: Number((input.volumeToday / (avgVol * elapsed)).toFixed(2)),
      },
    },
  };
}
