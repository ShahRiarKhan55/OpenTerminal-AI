import type { Bar } from "./types.js";

/**
 * Pure, deterministic technical indicators. Every function returns null when
 * there is not enough (or invalid) data, never a guess. Inputs are oldest-first.
 */

const finite = (n: number) => Number.isFinite(n);

export function sma(values: number[], period: number): number | null {
  if (!Number.isInteger(period) || period < 1 || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    if (!finite(values[i])) return null;
    sum += values[i];
  }
  return sum / period;
}

/** Full EMA series seeded with the SMA of the first `period` values. */
export function emaSeries(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return out;
  let seed = 0;
  for (let i = 0; i < period; i++) {
    if (!finite(values[i])) return out;
    seed += values[i];
  }
  let prev = seed / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    if (!finite(values[i])) return out;
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  const s = emaSeries(values, period);
  return s.length ? s[s.length - 1] : null;
}

/** Wilder's RSI. Needs period + 1 closes. */
export function rsi(closes: number[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1 || closes.length < period + 1) return null;
  if (closes.some((c) => !finite(c))) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's Average True Range. Needs period + 1 bars. */
export function atr(bars: Bar[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1 || bars.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const pc = bars[i - 1].close;
    if (![high, low, pc].every(finite)) return null;
    tr.push(Math.max(high - low, Math.abs(high - pc), Math.abs(low - pc)));
  }
  let a = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}

/** Cumulative volume-weighted average price using typical price (H+L+C)/3. */
export function vwap(bars: Bar[]): number | null {
  let pv = 0;
  let v = 0;
  for (const b of bars) {
    if (![b.high, b.low, b.close, b.volume].every(finite) || b.volume < 0) return null;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v > 0 ? pv / v : null;
}

export function highest(bars: Bar[], n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || bars.length < n) return null;
  let h = -Infinity;
  for (const b of bars.slice(-n)) {
    if (!finite(b.high)) return null;
    h = Math.max(h, b.high);
  }
  return h;
}

export function lowest(bars: Bar[], n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || bars.length < n) return null;
  let l = Infinity;
  for (const b of bars.slice(-n)) {
    if (!finite(b.low)) return null;
    l = Math.min(l, b.low);
  }
  return l;
}

export function avgVolume(bars: Bar[], n: number): number | null {
  if (!Number.isInteger(n) || n < 1 || bars.length < n) return null;
  let s = 0;
  for (const b of bars.slice(-n)) {
    if (!finite(b.volume) || b.volume < 0) return null;
    s += b.volume;
  }
  return s / n;
}
