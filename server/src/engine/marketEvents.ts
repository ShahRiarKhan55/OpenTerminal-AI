import type { Importance } from "../config.js";
import { etClock } from "../marketdata/time.js";
import { rsi } from "./indicators.js";
import { SESSION_LENGTH_MIN, SESSION_OPEN_MIN } from "./strategies.js";
import type { Bar } from "./types.js";

/** Alert-only observations (not trade signals). Pure functions of their inputs. */
export type DetectedEvent = {
  type: string;
  importance: Importance;
  dedupeKey: string;
  cooldownMs: number;
  title: string;
  body: string;
  facts: Record<string, number | string | boolean | null>;
};

const DAY_MS = 86_400_000;

export type QuoteFacts = {
  symbol: string;
  price: number;
  changePercent: number | null;
  volume: number | null;
  avgVolume: number | null;
  week52High: number | null;
};

const fmt = (n: number, d = 2) => n.toFixed(d);

/** Fraction of the regular session elapsed (0..1) at `nowMs`. */
export function sessionElapsed(nowMs: number): number {
  const c = etClock(nowMs);
  return Math.min(1, Math.max(0, (c.minutes - SESSION_OPEN_MIN) / SESSION_LENGTH_MIN));
}

export const MOVE_THRESHOLDS = [3, 5, 8, 12];

export function detectMarketEvents(q: QuoteFacts, daily: Bar[] | null, nowMs: number): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  const date = etClock(nowMs).dateKey;
  const { symbol } = q;

  // Large intraday move vs previous close; escalates through thresholds, one alert per level per day.
  if (q.changePercent !== null && Number.isFinite(q.changePercent)) {
    const abs = Math.abs(q.changePercent);
    const level = [...MOVE_THRESHOLDS].reverse().find((t) => abs >= t);
    if (level !== undefined) {
      const dir = q.changePercent > 0 ? "up" : "down";
      out.push({
        type: `move_${dir}`,
        importance: level >= 5 ? "high" : "normal",
        dedupeKey: `move:${symbol}:${dir}:${level}:${date}`,
        cooldownMs: DAY_MS,
        title: `${symbol} ${dir === "up" ? "up" : "down"} ${fmt(abs, 1)}% today`,
        body: `${symbol} is ${dir} ${fmt(abs, 2)}% versus the previous close (last ${fmt(q.price)}).`,
        facts: { changePercent: Number(fmt(q.changePercent, 2)), price: q.price, level },
      });
    }
  }

  // Volume running far above the time-of-day-adjusted average.
  const elapsed = sessionElapsed(nowMs);
  if (q.volume !== null && q.avgVolume !== null && q.avgVolume > 0 && elapsed >= 0.15) {
    const rel = q.volume / (q.avgVolume * elapsed);
    const level = rel >= 6 ? 6 : rel >= 3 ? 3 : 0;
    if (level) {
      out.push({
        type: "volume_spike",
        importance: level >= 6 ? "high" : "normal",
        dedupeKey: `volume:${symbol}:${level}:${date}`,
        cooldownMs: DAY_MS,
        title: `${symbol} volume ${fmt(rel, 1)}x normal`,
        body: `${symbol} volume is running about ${fmt(rel, 1)}x its typical pace for this time of day.`,
        facts: { relVolume: Number(fmt(rel, 2)), price: q.price },
      });
    }
  }

  // Daily RSI extremes, with today's live price as the latest close. Informational only.
  if (daily) {
    const done = daily.filter((b) => new Date(b.time * 1000).toISOString().slice(0, 10) < date).map((b) => b.close);
    const v = rsi([...done, q.price], 14);
    if (v !== null && (v <= 30 || v >= 70)) {
      const over = v >= 70;
      out.push({
        type: over ? "rsi_overbought" : "rsi_oversold",
        importance: "low",
        dedupeKey: `rsi:${symbol}:${over ? "ob" : "os"}:${date}`,
        cooldownMs: DAY_MS,
        title: `${symbol} daily RSI ${fmt(v, 0)} (${over ? "overbought" : "oversold"})`,
        body: `${symbol} 14-day RSI is ${fmt(v, 1)}. An extreme reading is context, not a signal.`,
        facts: { rsi14: Number(fmt(v, 2)), price: q.price },
      });
    }
  }

  // Trading within 1% of the 52-week high.
  if (q.week52High !== null && q.week52High > 0 && q.price >= q.week52High * 0.99 && q.price <= q.week52High * 1.05) {
    out.push({
      type: "near_52w_high",
      importance: "low",
      dedupeKey: `h52:${symbol}:${date}`,
      cooldownMs: DAY_MS,
      title: `${symbol} near 52-week high`,
      body: `${symbol} ${fmt(q.price)} is within 1% of (or above) its 52-week high ${fmt(q.week52High)}.`,
      facts: { price: q.price, week52High: q.week52High },
    });
  }
  return out;
}

export type CalendarEvent = { title: string; country: string; date: string; impact: string; forecast: string | null; previous: string | null };

/** High-impact US releases starting within the next `windowMin` minutes. */
export function detectUpcomingEconomicEvents(events: CalendarEvent[], nowMs: number, windowMin = 30): DetectedEvent[] {
  const out: DetectedEvent[] = [];
  for (const e of events) {
    if (e.impact !== "High" || e.country !== "USD") continue;
    const t = Date.parse(e.date);
    if (!Number.isFinite(t)) continue;
    const mins = (t - nowMs) / 60_000;
    if (mins <= 0 || mins > windowMin) continue;
    out.push({
      type: "econ_event_soon",
      importance: "normal",
      dedupeKey: `econ:${e.title}:${new Date(t).toISOString()}`,
      cooldownMs: 6 * 3_600_000,
      title: `${e.title} in ${Math.ceil(mins)} min`,
      body: `High-impact US release: ${e.title}. Forecast ${e.forecast ?? "n/a"}, previous ${e.previous ?? "n/a"}. Expect volatility; consider flat or reduced risk.`,
      facts: { minutes: Math.ceil(mins), forecast: e.forecast, previous: e.previous },
    });
  }
  return out;
}

export type MarketConditions = {
  asOf: number;
  regime: "risk_on" | "risk_off" | "neutral" | "unknown";
  indices: { symbol: string; price: number | null; changePercent: number | null; ageSec: number | null; delayClass: string; eligible: boolean }[];
  vix: number | null;
  note: string;
};

/**
 * Deterministic regime label from SPY's day change and VIX level:
 *   risk_off  SPY <= -0.5% or VIX >= 25
 *   risk_on   SPY >= +0.3% and VIX < 20
 *   neutral   otherwise; unknown when SPY is unavailable.
 */
export function classifyRegime(spyChangePct: number | null, vix: number | null): MarketConditions["regime"] {
  if (spyChangePct === null || !Number.isFinite(spyChangePct)) return "unknown";
  if (spyChangePct <= -0.5 || (vix !== null && vix >= 25)) return "risk_off";
  if (spyChangePct >= 0.3 && (vix === null || vix < 20)) return "risk_on";
  return "neutral";
}
