import { describe, expect, it } from "vitest";
import { detectBreakout20, detectOrb } from "../engine/strategies.js";
import { _resetLedger, summarize } from "../marketdata/ledger.js";
import { DEFAULT_POLICY } from "../marketdata/freshness.js";
import { createRuntime, gate } from "./runtime.js";
import { at, orbBars, quietDaily, World } from "./test-world.js";

describe("clock skew and bad timestamps", () => {
  it("a provider timestamp from the future (skewed clock) is rejected, not trusted", async () => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    w.setPrice("ABC", 101.0, { time: Math.floor(at(10, 5, 30) / 1000) + 600 });
    await w.tick(10, 5, 30);
    expect(w.count("signals")).toBe(0);
    expect(w.one<{ reason: string }>("SELECT reason FROM audit_log WHERE kind = 'data' AND symbol = 'ABC'").reason).toBe("future_timestamp");
  });

  it("a server clock that is ahead of the provider by minutes makes data stale rather than accepted", async () => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    w.setPrice("ABC", 101.0, { time: Math.floor(at(10, 5, 30) / 1000) - 400 }); // 6+ minutes behind the 120s real-time limit
    await w.tick(10, 5, 30);
    expect(w.count("signals")).toBe(0);
  });
});

describe("memory stays bounded", () => {
  it("a long-running worker over many symbols keeps every in-memory structure bounded", async () => {
    const syms = Array.from({ length: 30 }, (_, i) => `M${i}`);
    const w = new World({ symbols: syms, env: { MONITOR_MAX_SYMBOLS: "30" } });
    for (const s of syms) {
      w.setPrice(s, 100);
      w.intraday.set(s, orbBars(1, false));
    }
    _resetLedger();
    for (let i = 0; i < 400; i++) {
      for (const s of syms) w.setPrice(s, 100 + Math.sin(i / 7) * 0.4);
      await w.tick(10 + Math.floor((i % 300) / 60), (i % 300) % 60 || 1, i % 60);
    }
    expect(w.rt.intraday.size).toBeLessThanOrEqual(30);
    expect(w.rt.daily.size).toBeLessThanOrEqual(30);
    expect(w.rt.gates.size).toBeLessThanOrEqual(5000);
    expect(summarize(Date.now(), DEFAULT_POLICY).tracked).toBeLessThanOrEqual(500);
  });

  it("drops cached candles for symbols removed from the watchlist", async () => {
    const w = new World({ symbols: ["AAA", "BBB"] });
    for (const s of ["AAA", "BBB"]) w.intraday.set(s, orbBars(1, false));
    await w.tick(10, 0);
    expect([...w.rt.intraday.keys()].sort()).toEqual(["AAA", "BBB"]);
    w.db.prepare("DELETE FROM watchlist_items WHERE symbol = 'BBB'").run();
    await w.tick(10, 1);
    expect([...w.rt.intraday.keys(), ...w.rt.daily.keys()]).not.toContain("BBB");
  });

  it("the rate-limit gate map prunes old entries instead of growing forever", () => {
    const rt = createRuntime(0);
    const t0 = 1_000_000;
    for (let i = 0; i < 6000; i++) gate(rt, `k${i}`, 1000, t0);
    expect(rt.gates.size).toBe(6000);
    gate(rt, "later", 1000, t0 + 25 * 3_600_000); // triggers pruning of day-old keys
    expect(rt.gates.size).toBeLessThan(10);
  });
});

describe("operational volume and performance budgets", () => {
  it("a quiet market over many cycles writes almost nothing: no alert spam, no audit spam, constant-size state", async () => {
    const syms = Array.from({ length: 20 }, (_, i) => `Q${i}`);
    const w = new World({ symbols: syms, env: { MONITOR_MAX_SYMBOLS: "20" } });
    for (const s of syms) {
      w.setPrice(s, 100);
      w.intraday.set(s, orbBars(1, false));
    }
    for (let i = 0; i < 120; i++) await w.tick(10 + Math.floor(i / 60), i % 60, 0);
    expect(w.count("alerts")).toBe(0);
    expect(w.count("signals")).toBe(0);
    // This fixture's newest 5-minute bar is from 10:00, so over these 2 hours every symbol legitimately has
    // stale candles. That condition is audited at most once per symbol per 30 minutes (4 windows), never per cycle.
    const perKey = w.all<{ c: number }>("SELECT COUNT(*) c FROM audit_log WHERE kind = 'data' GROUP BY symbol, reason");
    expect(perKey.length).toBe(20);
    expect(Math.max(...perKey.map((r) => r.c))).toBeLessThanOrEqual(5);
    expect(w.count("audit_log")).toBeLessThanOrEqual(20 * 5 + 10); // 120 cycles x 20 symbols = 2400 observations -> ~100 lines
    expect(w.count("worker_state")).toBeLessThanOrEqual(5); // heartbeat/conditions/open_dates are upserts, not appends
  });

  it("a full 150-symbol watchlist completes a cycle quickly (processing cost, excluding network)", async () => {
    const syms = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(3, "0")}`);
    const w = new World({ symbols: syms, env: { MONITOR_MAX_SYMBOLS: "150" } });
    for (const s of syms) {
      w.setPrice(s, 100 + (s.charCodeAt(2) % 7));
      w.intraday.set(s, orbBars(1, false));
      w.daily.set(s, quietDaily());
    }
    const times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      await w.tick(10, i, 0);
      times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const worst = Math.max(...times);
    console.log(`150-symbol cycle: avg ${avg.toFixed(1)} ms, worst ${worst.toFixed(1)} ms`);
    // The real cycle time is dominated by provider latency; our own processing must be negligible next to a 15-60 s poll.
    // Measured ~10 ms avg / ~20 ms worst on a dev container; these budgets leave >10x headroom for slow CI
    // while still catching an accidental O(n^2) or per-symbol database scan.
    expect(avg).toBeLessThan(250);
    expect(worst).toBeLessThan(1000);
  });

  it("strategy detection is cheap even on a full day of bars", () => {
    const bars = orbBars(1, true);
    const daily = quietDaily();
    const now = at(10, 5, 30);
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      detectOrb({ symbol: "A", bars, nowMs: now });
      detectBreakout20({ symbol: "A", daily, price: 101, volumeToday: 1e6, nowMs: now });
    }
    const perCall = (performance.now() - t0) / 4000;
    console.log(`strategy detection: ${(perCall * 1000).toFixed(0)} µs per call`);
    expect(perCall).toBeLessThan(2); // milliseconds
  });
});
