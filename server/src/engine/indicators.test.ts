import { describe, expect, it } from "vitest";
import { atr, avgVolume, ema, emaSeries, highest, lowest, rsi, sma, vwap } from "./indicators.js";
import type { Bar } from "./types.js";

const bar = (high: number, low: number, close: number, volume = 100, open = close): Bar => ({ time: 0, open, high, low, close, volume });

// A 33-close series used for RSI checks. Expected values below are derived BY HAND
// from the raw changes (not by calling rsi()), so they check the implementation
// against the textbook formula rather than against itself.
const SERIES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41,
  46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13,
];
const WILDER = SERIES;

describe("sma", () => {
  it("averages the last N values", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([10], 1)).toBe(10);
  });
  it("returns null without enough or valid data", () => {
    expect(sma([1, 2], 3)).toBeNull();
    expect(sma([1, NaN, 3], 3)).toBeNull();
    expect(sma([1, 2, 3], 0)).toBeNull();
    expect(sma([1, 2, 3], 1.5)).toBeNull();
  });
});

describe("ema", () => {
  it("seeds with the SMA then applies k = 2/(n+1)", () => {
    // period 3: seed = (1+2+3)/3 = 2 ; k = 0.5 ; next = 4*0.5 + 2*0.5 = 3 ; next = 5*0.5 + 3*0.5 = 4
    expect(emaSeries([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
    expect(ema([1, 2, 3, 4, 5], 3)).toBe(4);
  });
  it("is null when too short or invalid", () => {
    expect(ema([1, 2], 3)).toBeNull();
    expect(emaSeries([1, 2, NaN, 4], 2)[3]).toBeNull();
  });
});

describe("rsi (Wilder)", () => {
  it("matches the textbook formula, derived by hand from the raw changes", () => {
    // First 14 changes: gains 0.06+0.72+0.50+0.27+0.32+0.42+0.24+0.14+0.67 = 3.34 ; losses 0.25+0.54+0.19+0.42 = 1.40
    const g0 = 3.34 / 14;
    const l0 = 1.4 / 14;
    expect(rsi(WILDER.slice(0, 15), 14)!).toBeCloseTo(100 - 100 / (1 + g0 / l0), 6); // 70.4641...
    // Next close 46.00 (change -0.28): Wilder smoothing (n-1)/n of the old average plus 1/n of the new value.
    const g1 = (g0 * 13 + 0) / 14;
    const l1 = (l0 * 13 + 0.28) / 14;
    expect(rsi(WILDER.slice(0, 16), 14)!).toBeCloseTo(100 - 100 / (1 + g1 / l1), 6);
  });
  it("is 100 for a pure up-move, 0 for a pure down-move, 50 when flat", () => {
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 + i))).toBe(100);
    expect(rsi(Array.from({ length: 20 }, (_, i) => 100 - i))).toBe(0);
    expect(rsi(new Array(20).fill(100))).toBe(50);
  });
  it("needs period + 1 closes and finite input", () => {
    expect(rsi(WILDER.slice(0, 14), 14)).toBeNull();
    expect(rsi([...WILDER.slice(0, 15), NaN], 14)).toBeNull();
  });
  it("stays within 0..100 on a noisy series", () => {
    const v = rsi(WILDER, 14)!;
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThan(100);
  });
});

describe("atr (Wilder)", () => {
  it("computes true range with gaps, then Wilder smoothing", () => {
    // bars: prev close 10; TRs: b1 = max(2, |12-10|, |10-10|)=2 ; b2 (gap up) = max(1, |13-11|=... )
    const bars = [bar(10, 10, 10), bar(12, 10, 11), bar(14, 13, 13.5), bar(13, 11, 12)];
    // TR1 = max(12-10, |12-10|, |10-10|) = 2
    // TR2 = max(14-13, |14-11|, |13-11|) = 3
    // TR3 = max(13-11, |13-13.5|, |11-13.5|) = 2.5
    // period 2: first ATR = (2+3)/2 = 2.5 ; then (2.5*1 + 2.5)/2 = 2.5
    expect(atr(bars, 2)).toBeCloseTo(2.5, 10);
  });
  it("applies smoothing to later bars", () => {
    const bars = [bar(10, 10, 10), bar(12, 10, 11), bar(14, 13, 13.5), bar(20, 11, 12)];
    // TR3 = max(9, |20-13.5|, |11-13.5|) = 9 ; ATR = (2.5*1 + 9)/2 = 5.75
    expect(atr(bars, 2)).toBeCloseTo(5.75, 10);
  });
  it("is null with too few bars or bad data", () => {
    expect(atr([bar(1, 1, 1), bar(2, 1, 1)], 2)).toBeNull();
    expect(atr([bar(1, 1, 1), bar(NaN, 1, 1), bar(2, 1, 1)], 2)).toBeNull();
  });
});

describe("vwap", () => {
  it("weights typical price by volume", () => {
    // typical: (12+8+10)/3 = 10 (vol 100) ; (22+18+20)/3 = 20 (vol 300) -> (1000 + 6000)/400 = 17.5
    expect(vwap([bar(12, 8, 10, 100), bar(22, 18, 20, 300)])).toBeCloseTo(17.5, 10);
  });
  it("is null with zero volume, negative volume, or bad numbers", () => {
    expect(vwap([bar(1, 1, 1, 0)])).toBeNull();
    expect(vwap([bar(1, 1, 1, -5)])).toBeNull();
    expect(vwap([bar(NaN, 1, 1, 5)])).toBeNull();
    expect(vwap([])).toBeNull();
  });
});

describe("highest / lowest / avgVolume", () => {
  const bars = [bar(5, 1, 3, 10), bar(9, 2, 4, 20), bar(7, 0.5, 5, 30)];
  it("look only at the last N bars", () => {
    expect(highest(bars, 2)).toBe(9);
    expect(highest(bars, 1)).toBe(7);
    expect(lowest(bars, 3)).toBe(0.5);
    expect(lowest(bars, 2)).toBe(0.5);
    expect(avgVolume(bars, 2)).toBe(25);
  });
  it("are null when short or invalid", () => {
    expect(highest(bars, 4)).toBeNull();
    expect(lowest(bars, 0)).toBeNull();
    expect(avgVolume([bar(1, 1, 1, NaN)], 1)).toBeNull();
  });
});
