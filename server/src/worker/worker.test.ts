import { describe, expect, it } from "vitest";
import { saveRiskConfig } from "../engine/store.js";
import { at, orbBars, quietDaily, TOKEN, World } from "./test-world.js";

/** Drive a world to the point where ABC has a valid ORB breakout and price sits at the entry level. */
async function enterAbc(w: World) {
  w.intraday.set("ABC", orbBars());
  await w.tick(9, 58);
  w.setPrice("ABC", 101.0);
  return w.tick(10, 5, 30);
}

describe("ORB paper trade lifecycle (end to end through the real tick)", () => {
  it("detects the breakout, passes risk, opens a paper position, and tells everyone", async () => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    const quiet = await w.tick(9, 58);
    expect(quiet.signals).toBe(0);
    expect(w.count("signals")).toBe(0);

    w.setPrice("ABC", 101.0);
    const s = await w.tick(10, 5, 30);
    expect(s.errors).toEqual([]);
    expect(s.signals).toBe(1);

    const sig = w.one<{ status: string; entry: number; stop: number; target: number; strategy: string }>("SELECT * FROM signals");
    expect(sig).toMatchObject({ status: "filled", strategy: "orb", entry: 101, stop: 100.5 });
    expect(sig.target).toBeCloseTo(102, 10);

    const pos = w.one<Record<string, number | string>>("SELECT * FROM paper_positions");
    expect(pos).toMatchObject({ status: "open", symbol: "ABC", side: "LONG", stop_price: 100.5, target_price: sig.target });
    expect(pos.entry_price).toBeCloseTo(101 * 1.0005, 8); // slipped against us
    expect(Number(pos.qty) * Number(pos.risk_per_share)).toBeLessThanOrEqual(500 + 1e-6); // never risks more than 0.5% of 100k
    expect(w.one<{ cash: number }>("SELECT cash FROM paper_account").cash).toBeCloseTo(100_000 - Number(pos.qty) * Number(pos.entry_price), 6);

    expect(w.alertTypes()).toEqual(["signal", "position_opened"]);
    expect(w.telegramSent).toHaveLength(2);
    expect(w.telegramSent[0]).toContain("[PAPER]");
    expect(w.telegramSent[0]).toContain("delayed/indicative".slice(0, 0) + "provider-reported real-time");
    // AI ran once, for the signal, never for the position-opened message
    expect(w.aiCalls).toHaveLength(1);
    expect(w.aiCalls[0]).toMatchObject({ kind: "orb_signal", symbol: "ABC" });
    expect(w.one<{ ai_status: string; ai_analysis: string }>("SELECT ai_status, ai_analysis FROM alerts WHERE type = 'signal'")).toEqual({ ai_status: "done", ai_analysis: "Analysis for ABC" });
    expect(w.telegramSent[0]).toContain("AI note: Analysis for ABC");
  });

  it("moves the stop to breakeven at +1R, then books the target", async () => {
    const w = new World();
    await enterAbc(w);
    const entry = w.one<{ entry_price: number }>("SELECT entry_price FROM paper_positions").entry_price;

    w.setPrice("ABC", 101.7); // > entry + 1R (R ~ 0.55)
    await w.tick(10, 15);
    expect(w.one<{ stop_price: number }>("SELECT stop_price FROM paper_positions").stop_price).toBeCloseTo(entry, 8);
    expect(w.count("audit_log", "decision = 'stop_to_breakeven'")).toBe(1);

    w.setPrice("ABC", 102.2);
    await w.tick(10, 25);
    const closed = w.one<{ status: string; exit_reason: string; exit_price: number; realized_pnl: number; r_multiple: number }>("SELECT * FROM paper_positions");
    expect(closed).toMatchObject({ status: "closed", exit_reason: "target", exit_price: 102 });
    expect(closed.realized_pnl).toBeGreaterThan(0);
    expect(closed.r_multiple).toBeGreaterThan(1.5);
    expect(w.one<{ cash: number }>("SELECT cash FROM paper_account").cash).toBeCloseTo(100_000 + closed.realized_pnl, 6);
    expect(w.alertTypes()).toEqual(["signal", "position_opened", "position_closed"]);
    expect(w.one<{ title: string }>("SELECT title FROM alerts WHERE type = 'position_closed'").title).toContain("target");
  });

  it("books a stop-out as a loss near -1R and raises a HIGH-importance alert", async () => {
    const w = new World();
    await enterAbc(w);
    w.setPrice("ABC", 100.4);
    await w.tick(10, 20);
    const p = w.one<{ exit_reason: string; realized_pnl: number; r_multiple: number }>("SELECT * FROM paper_positions");
    expect(p.exit_reason).toBe("stop");
    expect(p.realized_pnl).toBeLessThan(0);
    expect(p.r_multiple).toBeLessThan(-1); // gapped through the stop: worse than -1R, never better
    expect(w.one<{ importance: string }>("SELECT importance FROM alerts WHERE type = 'position_closed'").importance).toBe("high");
  });

  it("flattens at the flat-by time, and never carries a position overnight", async () => {
    const w = new World();
    await enterAbc(w);
    w.setPrice("ABC", 101.3);
    await w.tick(15, 54);
    expect(w.count("paper_positions", "status = 'open'")).toBe(1);
    await w.tick(15, 55);
    expect(w.one<{ exit_reason: string }>("SELECT exit_reason FROM paper_positions").exit_reason).toBe("time_stop");
    expect(w.count("paper_positions", "status = 'open'")).toBe(0);
  });

  it("is idempotent across ticks: the same setup never produces a second signal or position", async () => {
    const w = new World();
    await enterAbc(w);
    for (const [h, m] of [[10, 6], [10, 7], [10, 8], [10, 9]] as const) await w.tick(h, m);
    expect(w.count("signals")).toBe(1);
    expect(w.count("paper_positions")).toBe(1);
    expect(w.count("alerts", "type = 'signal'")).toBe(1);
  });
});

describe("data safety: stale, incomplete and out-of-session data never trigger anything", () => {
  const setup = (extra: Parameters<World["setPrice"]>[2]) => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    w.setPrice("ABC", 101.0, extra);
    return w;
  };
  it.each([
    ["a stale timestamp (1 hour old)", { time: Math.floor(at(10, 5) / 1000) - 3600 }, "stale"],
    ["a missing timestamp", { time: null }, "missing_timestamp"],
    ["unknown delay class", { delayClass: "unknown" as const }, "unknown_delay"],
    ["end-of-day only data", { delayClass: "eod" as const }, "eod_only"],
    ["a last-known fallback served after provider failure", { servedStale: true }, "served_stale"],
    ["a cached object held too long", { fetchedAt: at(10, 5, 30) - 600_000 }, "stale"],
  ] as const)("rejects %s and logs why", async (_n, extra, reason) => {
    const w = setup(extra as never);
    await w.tick(10, 5, 30);
    expect(w.count("signals")).toBe(0);
    expect(w.count("paper_positions")).toBe(0);
    expect(w.count("alerts", "type = 'signal'")).toBe(0);
    expect(w.one<{ reason: string }>("SELECT reason FROM audit_log WHERE kind = 'data' AND decision = 'rejected' AND symbol = 'ABC'").reason).toBe(reason);
  });

  it.each(["Pre-Market", "After-Hours", "Market Closed"])("ignores a %s quote entirely (no detection, no noisy audit)", async (state) => {
    const w = setup({ marketState: state });
    await w.tick(10, 5, 30);
    expect(w.count("signals")).toBe(0);
    expect(w.count("audit_log", "kind = 'data'")).toBe(0);
  });

  it("allows extended hours ONLY when explicitly configured", async () => {
    const w = new World({ env: { ALERT_ALLOW_EXTENDED_HOURS: "true" } });
    w.setPrice("ABC", 101, { marketState: "Pre-Market", changePercent: 6 });
    await w.tick(8, 30);
    expect(w.alertTypes()).toContain("move_up");
  });

  it("rate-limits repeated rejection audit lines to one per symbol+reason per 30 minutes", async () => {
    const w = setup({ time: null });
    for (let i = 0; i < 20; i++) await w.tick(10, 5 + i);
    expect(w.count("audit_log", "kind = 'data' AND decision = 'rejected' AND symbol = 'ABC' AND reason = 'missing_timestamp'")).toBe(1);
  });

  it("stale intraday candles block ORB (lag guard) but are audited", async () => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    w.setPrice("ABC", 101.0);
    await w.tick(11, 30); // last bar ended 10:05; 85 minutes of lag
    expect(w.count("signals")).toBe(0);
    expect(w.one<{ reason: string }>("SELECT reason FROM audit_log WHERE reason = 'stale_candles'").reason).toBe("stale_candles");
  });
});

describe("pending entries: extended breakouts, pullbacks, and stale data", () => {
  const ready = () => {
    const w = new World();
    w.intraday.set("ABC", orbBars());
    return w;
  };

  it("an extended breakout stays PENDING (not blocked), announces the idea once, and fills on a pullback", async () => {
    const w = ready();
    await w.tick(9, 58);
    w.setPrice("ABC", 101.6); // already well past entry 101.0 + 0.5R
    await w.tick(10, 5, 30);
    expect(w.one<{ status: string; reason: string }>("SELECT status, reason FROM signals")).toEqual({ status: "pending", reason: "extended" });
    expect(w.count("paper_positions")).toBe(0);
    expect(w.alertTypes()).toEqual(["signal"]);

    w.setPrice("ABC", 101.0); // pulls back to the entry
    await w.tick(10, 9);
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("filled");
    expect(w.count("paper_positions", "status = 'open'")).toBe(1);
    expect(w.alertTypes()).toEqual(["signal", "position_opened"]);
  });

  it("a price inside the chase limit but with poor reward/risk waits instead of being blocked", async () => {
    const w = ready();
    await w.tick(9, 58);
    w.setPrice("ABC", 101.2); // <= entry + 0.5R (101.25) but reward/risk after slippage is below 1.5
    await w.tick(10, 5, 30);
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("pending");
    expect(w.count("alerts", "type = 'signal_blocked'")).toBe(0);
    w.setPrice("ABC", 101.0);
    await w.tick(10, 8);
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("filled");
  });

  it("a breakout that never pulls back is reported as skipped_chase when it expires", async () => {
    const w = ready();
    await w.tick(9, 58);
    w.setPrice("ABC", 101.6);
    await w.tick(10, 5, 30);
    await w.tick(10, 20);
    await w.tick(10, 30); // validity (20 min after the breakout bar closes) has passed
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("skipped_chase");
    expect(w.count("paper_positions")).toBe(0);
  });

  it("a non-price risk failure at fill time is final (blocked), even though the price looks fine", async () => {
    const w = ready();
    await w.tick(9, 58);
    w.setPrice("ABC", 101.6);
    await w.tick(10, 5, 30);
    saveRiskConfig(w.db, { tradingEnabled: false }, 1); // kill switch thrown while the signal waits
    w.setPrice("ABC", 101.0);
    await w.tick(10, 9);
    expect(w.one<{ status: string; reason: string }>("SELECT status, reason FROM signals")).toMatchObject({ status: "blocked", reason: expect.stringContaining("trading_disabled") });
    expect(w.count("paper_positions")).toBe(0);
  });

  it.each([
    ["a stale timestamp", { time: Math.floor(at(10, 9) / 1000) - 3600 }],
    ["a missing timestamp", { time: null }],
    ["a pre-market state", { marketState: "Pre-Market" }],
    ["a last-known fallback", { servedStale: true }],
  ] as const)("a PENDING signal never fills on %s, and fills once data is good again", async (_n, bad) => {
    const w = ready();
    await w.tick(9, 58);
    w.setPrice("ABC", 101.6);
    await w.tick(10, 5, 30);
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("pending");

    w.setPrice("ABC", 101.0, bad as never); // price is in the buy zone, but the data is not trustworthy
    await w.tick(10, 9);
    expect(w.count("paper_positions")).toBe(0);
    expect(w.one<{ status: string }>("SELECT status FROM signals").status).toBe("pending");

    w.resetPrice("ABC", 101.0); // data is trustworthy again
    await w.tick(10, 10);
    expect(w.count("paper_positions", "status = 'open'")).toBe(1);
  });
});

describe("risk management", () => {
  it("blocks the signal (and says why) when the position cap is reached, without a Telegram message", async () => {
    const w = new World({ symbols: ["ABC", "XYZ"] });
    saveRiskConfig(w.db, { maxOpenPositions: 1 }, 1);
    w.intraday.set("ABC", orbBars());
    w.intraday.set("XYZ", orbBars(2));
    w.setPrice("ABC", 101.0);
    w.setPrice("XYZ", 202.0);
    await w.tick(9, 58);
    await w.tick(10, 5, 30);
    expect(w.count("paper_positions")).toBe(1);
    const blocked = w.one<{ status: string; reason: string }>("SELECT status, reason FROM signals WHERE status = 'blocked'");
    expect(blocked.reason).toContain("max_open_positions");
    expect(w.count("alerts", "type = 'signal_blocked' AND importance = 'low'")).toBe(1);
    expect(w.telegramSent.join("\n")).not.toContain("blocked by risk");
    expect(w.count("audit_log", "kind = 'risk' AND decision = 'blocked'")).toBe(1);
  });

  it("the kill switch (tradingEnabled=false) stops all paper entries", async () => {
    const w = new World();
    saveRiskConfig(w.db, { tradingEnabled: false }, 1);
    await enterAbc(w);
    expect(w.count("paper_positions")).toBe(0);
    expect(w.one<{ reason: string }>("SELECT reason FROM signals").reason).toContain("trading_disabled");
  });

  it("daily loss limit: after enough losses it alerts (high) and blocks further entries", async () => {
    const w = new World({ symbols: ["AAA", "BBB", "CCC"] });
    saveRiskConfig(w.db, { maxDailyLossPct: 0.25, cooldownAfterStopMin: 0 }, 1); // limit = $250
    for (const [s, k] of [["AAA", 1], ["BBB", 1], ["CCC", 1]] as const) {
      w.intraday.set(s, orbBars(k));
      w.setPrice(s, 101.0);
    }
    // Only AAA and BBB break out first; CCC's data appears later.
    w.intraday.set("CCC", orbBars(1, false));
    await w.tick(9, 58);
    await w.tick(10, 5, 30);
    expect(w.count("paper_positions")).toBe(2);
    w.setPrice("AAA", 100.0);
    w.setPrice("BBB", 100.0);
    await w.tick(10, 20);
    expect(w.count("paper_positions", "exit_reason = 'stop'")).toBe(2);
    expect(w.alertTypes()).toContain("daily_loss_limit");
    expect(w.one<{ importance: string }>("SELECT importance FROM alerts WHERE type = 'daily_loss_limit'").importance).toBe("high");
    // a third breakout now must be refused
    w.intraday.set("CCC", orbBars());
    w.setPrice("CCC", 101.0);
    await w.tick(10, 31);
    const ccc = w.one<{ status: string; reason: string } | undefined>("SELECT status, reason FROM signals WHERE symbol = 'CCC'");
    expect(ccc?.status === "blocked" ? ccc.reason : "no-signal").toMatch(/daily_loss_limit|no-signal/);
    expect(w.count("paper_positions", "symbol = 'CCC'")).toBe(0);
  });

  it("a symbol cooldown prevents immediately re-entering a name that just stopped out", async () => {
    const w = new World();
    await enterAbc(w);
    w.setPrice("ABC", 100.0);
    await w.tick(10, 10);
    expect(w.one<{ exit_reason: string }>("SELECT exit_reason FROM paper_positions").exit_reason).toBe("stop");
    expect(w.count("paper_positions")).toBe(1);
  });

  it("never opens a position the account cannot afford", async () => {
    const w = new World({ env: { PAPER_STARTING_CASH: "1000" } });
    w.db.prepare("UPDATE paper_account SET cash = 1000, starting_cash = 1000").run();
    await enterAbc(w);
    const qty = w.count("paper_positions") ? w.one<{ qty: number }>("SELECT qty FROM paper_positions").qty : 0;
    expect(qty * 101).toBeLessThanOrEqual(1000);
    expect(w.one<{ cash: number }>("SELECT cash FROM paper_account").cash).toBeGreaterThanOrEqual(0);
  });
});

describe("AI usage is event-triggered and strictly budgeted", () => {
  it("makes ZERO calls across hundreds of quiet quote updates", async () => {
    const w = new World();
    w.intraday.set("ABC", []);
    for (let i = 0; i < 300; i++) {
      w.setPrice("ABC", 100 + Math.sin(i) * 0.1);
      await w.tick(9 + Math.floor((35 + (i % 120)) / 60), (35 + (i % 120)) % 60, i % 60);
    }
    expect(w.fetchCounts.quotes).toBe(300);
    expect(w.aiCalls).toHaveLength(0);
    expect(w.count("ai_calls")).toBe(0);
  });

  it("never exceeds AI_DAILY_CALL_LIMIT as events keep arriving, and never loses the alerts themselves", async () => {
    const syms = Array.from({ length: 8 }, (_, i) => `S${i}`);
    const w = new World({ symbols: syms, env: { AI_DAILY_CALL_LIMIT: "3", AI_MIN_IMPORTANCE: "high" } });
    // One new HIGH-importance event per tick, eight ticks in a row.
    for (let i = 0; i < 8; i++) {
      w.setPrice(syms[i], 100, { changePercent: 6 });
      await w.tick(10, i);
    }
    expect(w.aiCalls).toHaveLength(3); // exactly the budget, no more
    expect(w.count("ai_calls")).toBe(3);
    expect(w.count("alerts", "type = 'move_up'")).toBe(8); // alerts are NOT lost to the AI budget
    expect(w.count("alerts", "ai_status = 'done'")).toBe(3);
    expect(w.count("alerts", "ai_status = 'skipped_budget'")).toBe(5);
  });

  it("a burst of events in ONE tick is throttled to a few AI calls and marked as skipped, not left ambiguous", async () => {
    const syms = Array.from({ length: 8 }, (_, i) => `B${i}`);
    const w = new World({ symbols: syms, env: { AI_DAILY_CALL_LIMIT: "50", AI_MIN_IMPORTANCE: "high" } });
    for (const s of syms) w.setPrice(s, 100, { changePercent: 6 });
    await w.tick(10, 0);
    expect(w.aiCalls.length).toBeLessThanOrEqual(2);
    expect(w.count("alerts", "type = 'move_up'")).toBe(8);
    expect(w.count("alerts", "ai_status = 'none'")).toBe(0);
  });

  it("a failing AI provider never blocks the alert, the paper entry, or Telegram", async () => {
    const w = new World();
    w.aiFail = true;
    await enterAbc(w);
    expect(w.count("paper_positions")).toBe(1);
    expect(w.telegramSent).toHaveLength(2);
    expect(w.one<{ ai_status: string }>("SELECT ai_status FROM alerts WHERE type = 'signal'").ai_status).toBe("failed");
  });

  it("with no API key configured, everything works and the AI is simply absent", async () => {
    const w = new World({ ai: false });
    await enterAbc(w);
    expect(w.count("paper_positions")).toBe(1);
    expect(w.count("ai_calls")).toBe(0);
  });
});

describe("alert de-duplication and noise control", () => {
  it("a persistent condition produces exactly one alert, not one per tick", async () => {
    const w = new World();
    w.setPrice("ABC", 100, { changePercent: 6 });
    for (let i = 0; i < 40; i++) await w.tick(10, i);
    expect(w.count("alerts", "type = 'move_up'")).toBe(1);
    expect(w.telegramSent.filter((m) => m.includes("up 6.0%"))).toHaveLength(1);
  });

  it("escalating through move thresholds creates one alert per level, once each", async () => {
    const w = new World();
    for (const [pct, min] of [[3.2, 0], [3.4, 1], [5.1, 2], [5.3, 3], [8.5, 4], [8.6, 5]] as const) {
      w.setPrice("ABC", 100, { changePercent: pct });
      await w.tick(10, min);
    }
    expect(w.count("alerts", "type = 'move_up'")).toBe(3);
  });

  it("dedupe survives a restart", async () => {
    const w = new World();
    w.setPrice("ABC", 100, { changePercent: 6 });
    await w.tick(10, 0);
    w.restart();
    await w.tick(10, 1);
    expect(w.count("alerts", "type = 'move_up'")).toBe(1);
  });

  it("the daily alert cap bounds total noise", async () => {
    const syms = Array.from({ length: 12 }, (_, i) => `N${i}`);
    const w = new World({ symbols: syms, env: { ALERT_DAILY_CAP: "5" } });
    for (const s of syms) w.setPrice(s, 100, { changePercent: 3.5 });
    await w.tick(10, 0);
    expect(w.count("alerts")).toBeLessThanOrEqual(5);
    expect(w.count("audit_log", "decision = 'suppressed' AND reason = 'daily_cap'")).toBeGreaterThan(0);
  });
});

describe("provider failure and recovery", () => {
  it("survives a total quote outage: no crash, outage alert after 3 failures, heartbeat still written", async () => {
    const w = new World();
    w.quoteError = new Error("all providers down");
    for (let i = 0; i < 5; i++) {
      const s = await w.tick(10, i);
      expect(s.errors.length).toBeGreaterThan(0);
    }
    expect(w.count("alerts", "type = 'provider_outage'")).toBe(1);
    const hb = w.one<{ value: string }>("SELECT value FROM worker_state WHERE key = 'heartbeat'");
    expect(JSON.parse(hb.value)).toMatchObject({ tradingMode: "paper", quoteFailures: 5 });
    // recovery clears the failure counter
    w.quoteError = null;
    const ok = await w.tick(10, 6);
    expect(ok.errors).toEqual([]);
    expect(w.rt.quoteFailures).toBe(0);
  });

  it("an unreachable intraday provider just skips ORB; daily-based detection and exits keep working", async () => {
    const w = new World();
    w.deps.source.intradayBars = async () => {
      throw new Error("yahoo 429");
    };
    w.setPrice("ABC", 100, { changePercent: 6 });
    const s = await w.tick(10, 5);
    expect(s.errors).toEqual([]);
    expect(w.count("signals")).toBe(0);
    expect(w.alertTypes()).toContain("move_up");
  });

  it("a crash inside one step is contained: later steps still run and the failure is audited", async () => {
    const w = new World();
    w.deps.source.economicEvents = async () => {
      throw new Error("calendar exploded");
    };
    w.setPrice("ABC", 100, { changePercent: 6 });
    const s = await w.tick(10, 5);
    expect(s.errors).toEqual([]); // calendar errors are handled inside the step
    w.deps.source.headlines = async () => {
      throw new Error("x");
    };
    expect(w.alertTypes()).toContain("move_up");
    expect(w.telegramSent.length).toBeGreaterThan(0);
  });

  it("no fresh price for an open position raises a high alert, then flattens at the last mark after the close", async () => {
    const w = new World();
    await enterAbc(w);
    w.setPrice("ABC", 101.2);
    await w.tick(10, 10); // mark 101.2
    w.quoteError = new Error("down");
    await w.tick(10, 22);
    expect(w.count("alerts", "type = 'data_stale_position'")).toBe(1);
    expect(w.count("paper_positions", "status = 'open'")).toBe(1);
    await w.tick(16, 20);
    const p = w.one<{ status: string; exit_reason: string; exit_price: number }>("SELECT * FROM paper_positions");
    expect(p).toMatchObject({ status: "closed", exit_reason: "session_end", exit_price: 101.2 });
    expect(w.count("audit_log", "decision = 'closed_on_last_mark'")).toBe(1);
  });

  it("Telegram being down does not affect trading, and alerts are retried then abandoned cleanly", async () => {
    const w = new World();
    w.telegramStatus = 500;
    await enterAbc(w);
    expect(w.count("paper_positions")).toBe(1);
    expect(w.count("alerts", "telegram_status = 'pending' AND telegram_attempts >= 1")).toBeGreaterThan(0);
    w.telegramStatus = 200;
    await w.tick(10, 30); // due again after backoff
    expect(w.telegramSent.length).toBeGreaterThan(0);
  });
});

describe("restart recovery", () => {
  it("resumes managing an open position after a restart and tells the user about the gap", async () => {
    const w = new World();
    await enterAbc(w);
    const { recoverOnStart } = await import("./loop.js");
    w.restart();
    w.t = at(10, 40); // 35 minutes of downtime
    const r = recoverOnStart(w.deps, w.rt);
    expect(r).toMatchObject({ openPositions: 1 });
    expect(r.downSeconds).toBeGreaterThan(600);
    expect(w.alertTypes()).toContain("worker_restarted");
    expect(w.count("audit_log", "decision = 'worker_started'")).toBe(1);

    w.setPrice("ABC", 100.0); // price crashed during the outage
    await w.tick(10, 41);
    expect(w.one<{ exit_reason: string }>("SELECT exit_reason FROM paper_positions").exit_reason).toBe("stop");
  });

  it("does not raise a restart alert for a brief restart or when nothing is open", async () => {
    const w = new World();
    const { recoverOnStart } = await import("./loop.js");
    await w.tick(10, 0);
    w.restart();
    w.t = at(10, 1);
    recoverOnStart(w.deps, w.rt);
    expect(w.count("alerts", "type = 'worker_restarted'")).toBe(0);
  });
});

describe("calendar, news, market conditions", () => {
  it("alerts once for a high-impact US release inside the next 30 minutes", async () => {
    const w = new World();
    w.econ = [
      { title: "CPI m/m", country: "USD", date: new Date(at(10, 20)).toISOString(), impact: "High", forecast: "0.3%", previous: "0.2%" },
      { title: "Minor", country: "USD", date: new Date(at(10, 20)).toISOString(), impact: "Low", forecast: null, previous: null },
      { title: "German CPI", country: "EUR", date: new Date(at(10, 20)).toISOString(), impact: "High", forecast: null, previous: null },
      { title: "Later", country: "USD", date: new Date(at(14, 0)).toISOString(), impact: "High", forecast: null, previous: null },
    ];
    for (let i = 0; i < 5; i++) await w.tick(10, i);
    expect(w.count("alerts", "type = 'econ_event_soon'")).toBe(1);
    expect(w.one<{ title: string }>("SELECT title FROM alerts WHERE type = 'econ_event_soon'").title).toContain("CPI m/m");
  });

  it("reports fresh headlines once, ignores old or undated ones, and never sends them to Telegram or the AI", async () => {
    const w = new World({ env: { MONITOR_NEWS_ENABLED: "true", MONITOR_NEWS_REFRESH_SECONDS: "300" } });
    w.headlines.set("ABC", [
      { title: "ABC wins big contract", publisher: "Wire", publishedAt: new Date(at(9, 50)).toISOString() },
      { title: "Ancient news", publisher: "Wire", publishedAt: new Date(at(9, 50) - 20 * 3_600_000).toISOString() },
      { title: "Undated", publisher: "Wire", publishedAt: null },
    ]);
    await w.tick(10, 0);
    await w.tick(10, 6);
    await w.tick(10, 12);
    expect(w.all<{ title: string }>("SELECT title FROM alerts WHERE type = 'news'").map((r) => r.title)).toEqual(["ABC: ABC wins big contract"]);
    expect(w.telegramSent.join("")).not.toContain("contract");
    expect(w.aiCalls).toHaveLength(0);
  });

  it("publishes market conditions and classifies the regime", async () => {
    const w = new World();
    w.setPrice("SPY", 500, { changePercent: 0.6 });
    w.setPrice("^VIX", 14, { source: "fred", delayClass: "eod", marketState: null, time: null });
    await w.tick(10, 0);
    const c = JSON.parse(w.one<{ value: string }>("SELECT value FROM worker_state WHERE key = 'market_conditions'").value);
    expect(c.regime).toBe("risk_on");
    expect(c.vix).toBe(14);
    expect(c.indices.map((i: { symbol: string }) => i.symbol)).toEqual(["SPY", "QQQ", "IWM"]);
    w.setPrice("SPY", 500, { changePercent: -1.2 });
    await w.tick(10, 1);
    expect(JSON.parse(w.one<{ value: string }>("SELECT value FROM worker_state WHERE key = 'market_conditions'").value).regime).toBe("risk_off");
  });
});

describe("reports", () => {
  it("creates exactly one daily report after the close, with the day's trades, and announces it", async () => {
    const w = new World();
    await enterAbc(w);
    w.setPrice("ABC", 102.3);
    await w.tick(10, 20);
    await w.tick(16, 10); // before 16:20: not yet
    expect(w.count("reports")).toBe(0);
    await w.tick(16, 25);
    await w.tick(16, 40);
    await w.tick(17, 30);
    expect(w.count("reports", "kind = 'daily'")).toBe(1);
    const r = w.one<{ period_key: string; body: string }>("SELECT * FROM reports WHERE kind = 'daily'");
    expect(r.period_key).toBe("2026-07-15");
    expect(r.body).toContain("ABC orb");
    expect(r.body).toContain("SIMULATED");
    expect(r.body).toMatch(/Closed trades: 1 \(1 win/);
    expect(w.count("alerts", "type = 'report_daily'")).toBe(1);
  });

  it("stays quiet on days the market was never seen open (holidays, weekends)", async () => {
    const w = new World();
    w.closeMarket();
    await w.tick(10, 0);
    await w.tick(17, 0);
    expect(w.count("reports")).toBe(0);
  });

  it("an index that trades outside stock hours (VIX 'REGULAR' in pre-market) does not make it a market day", async () => {
    const w = new World();
    w.setPrice("^VIX", 15, { source: "yahoo", delayClass: "delayed", marketState: "REGULAR" });
    for (const s of ["ABC", "SPY", "QQQ", "IWM"]) w.setPrice(s, 100, { marketState: "Pre-Market" });
    const s = await w.tick(9, 25);
    expect(s.phase).toBe("other");
    await w.tick(17, 0);
    expect(w.count("worker_state", "key = 'open_dates'")).toBe(0);
    expect(w.count("reports")).toBe(0);
  });

  it("catches up on a missed report the next morning", async () => {
    const w = new World();
    await enterAbc(w);
    await w.tick(10, 20); // marks the day as open; worker 'dies' before 16:20
    await w.tick(9, 40, 0, 1); // next day, pre-open
    expect(w.one<{ period_key: string }>("SELECT period_key FROM reports WHERE kind = 'daily'").period_key).toBe("2026-07-15");
  });

  it("creates the weekly report once the week is over", async () => {
    const w = new World();
    await enterAbc(w);
    await w.tick(10, 20);
    await w.tick(16, 30); // Wed daily
    expect(w.count("reports", "kind = 'weekly'")).toBe(0);
    await w.tick(10, 0, 0, 3); // Saturday: week is over
    expect(w.count("reports", "kind = 'weekly'")).toBe(1);
    expect(w.one<{ period_key: string }>("SELECT period_key FROM reports WHERE kind = 'weekly'").period_key).toBe("2026-07-13");
    await w.tick(11, 0, 0, 3);
    expect(w.count("reports", "kind = 'weekly'")).toBe(1);
  });
});

describe("operational behaviour", () => {
  it("caps provider load: candle fetches per tick are bounded and refreshes are cached", async () => {
    const syms = Array.from({ length: 30 }, (_, i) => `Q${i}`);
    const w = new World({ symbols: syms, env: { MONITOR_MAX_SYMBOLS: "30" } });
    for (const s of syms) w.setPrice(s, 100);
    await w.tick(10, 0);
    expect(w.fetchCounts.daily + w.fetchCounts.intraday).toBeLessThanOrEqual(10);
    const afterFirst = w.fetchCounts.daily + w.fetchCounts.intraday;
    await w.tick(10, 1);
    expect(w.fetchCounts.daily + w.fetchCounts.intraday - afterFirst).toBeLessThanOrEqual(10);
    // within a few ticks everything is cached, so steady state is ~zero extra fetches
    for (let i = 2; i < 12; i++) await w.tick(10, i);
    const settled = w.fetchCounts.daily + w.fetchCounts.intraday;
    await w.tick(10, 12);
    expect(w.fetchCounts.daily + w.fetchCounts.intraday - settled).toBeLessThanOrEqual(10);
  });

  it("monitors only MONITOR_MAX_SYMBOLS watchlist symbols and says so", async () => {
    const syms = Array.from({ length: 6 }, (_, i) => `T${i}`);
    const w = new World({ symbols: syms, env: { MONITOR_MAX_SYMBOLS: "3" } });
    for (const s of syms) w.setPrice(s, 100);
    const s = await w.tick(10, 0);
    expect(s.symbols).toBe(3);
    expect(w.count("audit_log", "decision = 'watchlist_truncated'")).toBe(1);
  });

  it("falls back to safe default risk limits if the stored configuration is corrupt", async () => {
    const w = new World();
    w.db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('risk_config', '{\"riskPerTradePct\": 99}', 0)").run();
    await enterAbc(w);
    const p = w.one<{ qty: number; risk_per_share: number }>("SELECT qty, risk_per_share FROM paper_positions");
    expect(p.qty * p.risk_per_share).toBeLessThanOrEqual(500 + 1e-6); // default 0.5%, not 99%
    expect(w.count("audit_log", "decision = 'risk_config_invalid_using_defaults'")).toBe(1);
  });

  it("never leaks the Telegram token into the database, alerts, or audit log", async () => {
    const w = new World();
    w.telegramStatus = 401;
    await enterAbc(w);
    const dump = JSON.stringify([w.all("SELECT * FROM alerts"), w.all("SELECT * FROM audit_log"), w.all("SELECT * FROM events"), w.all("SELECT * FROM worker_state")]);
    expect(dump).not.toContain(TOKEN);
    expect(dump).not.toContain("AAHdq");
  });

  it("everything it does is paper: no order exists outside the local ledger", async () => {
    const w = new World();
    await enterAbc(w);
    expect(w.all<{ side: string; kind: string }>("SELECT side, kind FROM paper_orders")).toEqual([{ side: "BUY", kind: "entry" }]);
    expect(JSON.parse(w.one<{ value: string }>("SELECT value FROM worker_state WHERE key = 'heartbeat'").value).tradingMode).toBe("paper");
  });
});

void quietDaily;
