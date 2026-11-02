import { describe, expect, it } from "vitest";
import { easternToEpochMs } from "../marketdata/time.js";
import { detectBreakout20, detectOrb } from "./strategies.js";
import type { Bar } from "./types.js";

// Monday 2026-07-13 (EDT, UTC-4).
const DATE = [2026, 6, 13] as const;
const et = (h: number, m: number) => easternToEpochMs(DATE[0], DATE[1], DATE[2], h, m)!;
const bar5 = (h: number, m: number, o: number, hi: number, lo: number, c: number, v: number): Bar => ({ time: et(h, m) / 1000, open: o, high: hi, low: lo, close: c, volume: v });

/** Six 5-minute bars 9:30-9:55 forming a 100.00 - 101.00 opening range, volume 1000/bar. */
function openingRange(): Bar[] {
  const out: Bar[] = [];
  const closes = [100.4, 100.6, 100.5, 100.7, 100.6, 100.8];
  for (let i = 0; i < 6; i++) {
    const m = 30 + i * 5;
    const hh = 9 + Math.floor(m / 60);
    out.push(bar5(hh, m % 60, closes[i], i === 3 ? 101.0 : 100.9, i === 1 ? 100.0 : 100.2, closes[i], 1000));
  }
  return out;
}

describe("detectOrb", () => {
  const nowAfter = (h: number, m: number) => et(h, m) + 1000; // just after a bar closes

  it("signals the first close above the range high on volume, above VWAP", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)];
    const r = detectOrb({ symbol: "ABC", bars, nowMs: et(10, 5) + 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.signal;
    expect(s).toMatchObject({ symbol: "ABC", strategy: "orb", side: "LONG", entry: 101, sessionDate: "2026-07-13" });
    expect(s.stop).toBeCloseTo(100.5, 10); // midpoint of 100.0/101.0
    expect(s.riskPerShare).toBeCloseTo(0.5, 10);
    expect(s.target).toBeCloseTo(102, 10); // entry + 2R
    expect(s.rewardRisk).toBe(2);
    expect(s.validUntilMs).toBe(et(10, 5) + 20 * 60_000);
    expect(s.meta.orHigh).toBe(101);
    expect(s.meta.orLow).toBe(100);
  });

  it("supports a stop at the range low", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)];
    const r = detectOrb({ symbol: "ABC", bars, nowMs: et(10, 5) + 1000, params: { stopMode: "low" } });
    expect(r.ok && r.signal.stop).toBe(100);
    expect(r.ok && r.signal.target).toBeCloseTo(103, 10);
  });

  it("ignores the in-progress bar (a breakout that has not closed is not a breakout)", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)];
    const r = detectOrb({ symbol: "ABC", bars, nowMs: et(10, 3) });
    expect(r).toEqual({ ok: false, skip: "no_post_range_bars" });
  });

  it("waits for the opening range to finish", () => {
    expect(detectOrb({ symbol: "A", bars: openingRange().slice(0, 4), nowMs: et(9, 50) + 1000 })).toEqual({ ok: false, skip: "opening_range_incomplete" });
  });

  it("does not chase a breakout that already happened earlier", () => {
    const bars = [
      ...openingRange(),
      bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800),
      bar5(10, 5, 101.3, 101.6, 101.2, 101.5, 1800),
    ];
    expect(detectOrb({ symbol: "A", bars, nowMs: et(10, 10) + 1000 })).toEqual({ ok: false, skip: "breakout_already_happened" });
  });

  it("requires a close, not just a wick, above the range high", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.6, 100.8, 100.9, 1800)];
    expect(detectOrb({ symbol: "A", bars, nowMs: et(10, 5) + 1000 })).toEqual({ ok: false, skip: "no_breakout" });
  });

  it("requires volume confirmation", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 900)];
    expect(detectOrb({ symbol: "A", bars, nowMs: et(10, 5) + 1000 })).toEqual({ ok: false, skip: "low_volume" });
  });

  it("requires the breakout close to be above session VWAP", () => {
    // A heavy-volume bar that WICKS far above the range but closes inside it (so it is not a
    // breakout) pulls session VWAP above the later, genuine breakout close.
    const bars = [
      ...openingRange(),
      bar5(10, 0, 100.9, 105, 100.5, 100.9, 50_000),
      bar5(10, 5, 100.9, 101.4, 100.9, 101.3, 1800),
    ];
    expect(detectOrb({ symbol: "A", bars, nowMs: et(10, 10) + 1000 })).toEqual({ ok: false, skip: "below_vwap" });
  });

  it("rejects ranges that are too narrow or too wide", () => {
    const narrow = openingRange().map((b) => ({ ...b, high: 100.5, low: 100.45, close: 100.48, open: 100.48 }));
    expect(detectOrb({ symbol: "A", bars: [...narrow, bar5(10, 0, 100.5, 101, 100.5, 100.9, 5000)], nowMs: et(10, 5) + 1000 })).toEqual({ ok: false, skip: "range_out_of_bounds" });
    const wide = openingRange().map((b, i) => (i === 1 ? { ...b, low: 90 } : b));
    expect(detectOrb({ symbol: "A", bars: [...wide, bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)], nowMs: et(10, 5) + 1000 })).toEqual({ ok: false, skip: "range_out_of_bounds" });
  });

  it("ignores bars from other days and from extended hours", () => {
    const yesterday = openingRange().map((b) => ({ ...b, time: b.time - 86_400 }));
    const pre: Bar = bar5(8, 0, 99, 150, 98, 149, 99999);
    const bars = [...yesterday, pre, ...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)];
    const r = detectOrb({ symbol: "A", bars, nowMs: nowAfter(10, 5) });
    expect(r.ok).toBe(true);
    expect(r.ok && r.signal.meta.orHigh).toBe(101);
  });

  it("does nothing on weekends and with bad params", () => {
    const sat = Date.UTC(2026, 6, 11, 15, 0, 0);
    expect(detectOrb({ symbol: "A", bars: openingRange(), nowMs: sat })).toEqual({ ok: false, skip: "not_a_trading_day" });
    expect(detectOrb({ symbol: "A", bars: openingRange(), nowMs: et(10, 5), params: { orMinutes: 7 } })).toEqual({ ok: false, skip: "invalid_params" });
  });

  it("is deterministic: same input, same output", () => {
    const bars = [...openingRange(), bar5(10, 0, 100.8, 101.4, 100.8, 101.3, 1800)];
    const a = detectOrb({ symbol: "A", bars, nowMs: et(10, 5) + 1000 });
    const b = detectOrb({ symbol: "A", bars: [...bars].reverse(), nowMs: et(10, 5) + 1000 });
    expect(a).toEqual(b);
  });
});

describe("detectBreakout20", () => {
  // 60 completed daily bars rising gently, average volume 1,000,000.
  const history = (() => {
    // build exactly 60 days ending before 2026-07-13
    const out: Bar[] = [];
    for (let i = 60; i >= 1; i--) {
      const t = Date.UTC(2026, 6, 13 - i) / 1000;
      const close = 100 + (60 - i) * 0.1;
      out.push({ time: t, open: close - 0.2, high: close + 0.5, low: close - 0.5, close, volume: 1_000_000 });
    }
    return out;
  })();
  const level = Math.max(...history.slice(-20).map((b) => b.high));
  const noon = et(12, 0); // 2.5h elapsed of 6.5h -> ~0.385

  it("signals a break of the 20-day high above trend on adjusted volume", () => {
    const r = detectBreakout20({ symbol: "ABC", daily: history, price: level + 0.3, volumeToday: 600_000, nowMs: noon });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.signal.entry).toBe(level);
    expect(r.signal.stop).toBeLessThan(level);
    expect(r.signal.target).toBeCloseTo(level + 2 * r.signal.riskPerShare, 10);
    expect(r.signal.riskPerShare).toBeCloseTo(1.5 * (r.signal.meta.atr14 as number), 2);
    expect(r.signal.validUntilMs).toBe(et(15, 30));
    expect(r.signal.meta.level20).toBe(level);
  });

  it("needs price strictly above the 20-day high", () => {
    expect(detectBreakout20({ symbol: "A", daily: history, price: level, volumeToday: 900_000, nowMs: noon })).toEqual({ ok: false, skip: "no_breakout" });
  });

  it("excludes the in-progress daily bar from the lookback", () => {
    const withToday: Bar[] = [...history, { time: Date.UTC(2026, 6, 13) / 1000, open: 120, high: 130, low: 119, close: 125, volume: 500_000 }];
    const r = detectBreakout20({ symbol: "A", daily: withToday, price: level + 0.3, volumeToday: 600_000, nowMs: noon });
    expect(r.ok).toBe(true);
    expect(r.ok && r.signal.entry).toBe(level); // not 130
  });

  it("rejects when price is below the 50-day trend", () => {
    const falling = history.map((b, i) => ({ ...b, close: 160 - i, high: i >= 40 ? 100 : 160 - i + 0.5 }));
    const r = detectBreakout20({ symbol: "A", daily: falling, price: 105, volumeToday: 900_000, nowMs: noon });
    expect(r.ok).toBe(false);
  });

  it("requires time-of-day-adjusted volume, and waits until enough session has elapsed", () => {
    expect(detectBreakout20({ symbol: "A", daily: history, price: level + 0.3, volumeToday: 100_000, nowMs: noon })).toEqual({ ok: false, skip: "low_volume" });
    expect(detectBreakout20({ symbol: "A", daily: history, price: level + 0.3, volumeToday: 9e9, nowMs: et(9, 45) })).toEqual({ ok: false, skip: "too_early_for_volume" });
    expect(detectBreakout20({ symbol: "A", daily: history, price: level + 0.3, volumeToday: null, nowMs: noon })).toEqual({ ok: false, skip: "no_volume" });
  });

  it("needs enough history and a sane price", () => {
    expect(detectBreakout20({ symbol: "A", daily: history.slice(-30), price: level + 1, volumeToday: 9e9, nowMs: noon })).toEqual({ ok: false, skip: "insufficient_history" });
    expect(detectBreakout20({ symbol: "A", daily: history, price: NaN, volumeToday: 9e9, nowMs: noon })).toEqual({ ok: false, skip: "invalid_price" });
    expect(detectBreakout20({ symbol: "A", daily: history, price: -1, volumeToday: 9e9, nowMs: noon })).toEqual({ ok: false, skip: "invalid_price" });
  });

  it("rejects a stop wider than the configured maximum", () => {
    const volatile = history.map((b, i) => (i > 40 ? { ...b, high: b.high + (i % 2 ? 12 : 0), low: b.low - (i % 2 ? 0 : 12) } : b));
    const lvl = Math.max(...volatile.slice(-20).map((b) => b.high));
    const r = detectBreakout20({ symbol: "A", daily: volatile, price: lvl + 1, volumeToday: 9e9, nowMs: noon, params: { maxStopPct: 2 } });
    expect(r).toEqual({ ok: false, skip: "stop_too_wide" });
  });

  it("does nothing on weekends", () => {
    expect(detectBreakout20({ symbol: "A", daily: history, price: level + 1, volumeToday: 9e9, nowMs: Date.UTC(2026, 6, 11, 16, 0, 0) })).toEqual({ ok: false, skip: "not_a_trading_day" });
  });
});
