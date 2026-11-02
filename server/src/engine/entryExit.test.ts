import { describe, expect, it } from "vitest";
import { easternToEpochMs } from "../marketdata/time.js";
import { applySlippage, evaluateEntry, evaluateExit } from "./entryExit.js";
import { DEFAULT_RISK } from "./risk.js";

const et = (h: number, m: number, day = 15) => easternToEpochMs(2026, 6, day, h, m)!;
const sig = { entry: 100, stop: 98, riskPerShare: 2, validUntilMs: et(11, 0) };
const cfg = { maxChaseR: 0.5 };

describe("applySlippage", () => {
  it("always works against the trader", () => {
    expect(applySlippage(100, "BUY", 10)).toBeCloseTo(100.1, 10);
    expect(applySlippage(100, "SELL", 10)).toBeCloseTo(99.9, 10);
    expect(applySlippage(100, "BUY", 0)).toBe(100);
  });
});

describe("evaluateEntry", () => {
  const now = et(10, 30);
  it("fills at or just above entry", () => {
    expect(evaluateEntry(sig, 100, now, cfg)).toEqual({ action: "fill", refPrice: 100 });
    expect(evaluateEntry(sig, 100.8, now, cfg)).toEqual({ action: "fill", refPrice: 100.8 });
  });
  it("fills at exactly the chase limit (entry + 0.5R = 101) but not past it", () => {
    expect(evaluateEntry(sig, 101, now, cfg).action).toBe("fill");
    expect(evaluateEntry(sig, 101.01, now, cfg)).toEqual({ action: "wait", extended: true });
  });
  it("waits while price is below entry but above the stop", () => {
    expect(evaluateEntry(sig, 99.5, now, cfg)).toEqual({ action: "wait", extended: false });
  });
  it("never chases, but a pullback into the entry zone is still tradable", () => {
    expect(evaluateEntry(sig, 103, now, cfg)).toEqual({ action: "wait", extended: true });
    expect(evaluateEntry(sig, 100.6, now, cfg)).toEqual({ action: "fill", refPrice: 100.6 });
  });
  it("invalidates at or below the stop, even if the window is still open", () => {
    expect(evaluateEntry(sig, 98, now, cfg).action).toBe("invalidate");
    expect(evaluateEntry(sig, 90, now, cfg).action).toBe("invalidate");
  });
  it("expires after validUntil, taking precedence over everything else", () => {
    expect(evaluateEntry(sig, 100.5, et(11, 1), cfg).action).toBe("expire");
    expect(evaluateEntry(sig, 100.5, et(11, 0), cfg).action).toBe("fill"); // boundary is inclusive
  });
  it("with maxChaseR 0 only fills exactly at the entry level", () => {
    expect(evaluateEntry(sig, 100, now, { maxChaseR: 0 }).action).toBe("fill");
    expect(evaluateEntry(sig, 100.01, now, { maxChaseR: 0 })).toEqual({ action: "wait", extended: true });
  });
});

describe("evaluateExit", () => {
  const pos = { entryPrice: 100, stopPrice: 98, targetPrice: 104, riskPerShare: 2, sessionDate: "2026-07-15" };
  const run = (price: number, now = et(10, 30), phase: "open" | "pre" | "post" | "closed" | "unknown" = "open", c = DEFAULT_RISK) =>
    evaluateExit(pos, price, now, phase, c);

  it("holds between stop and target", () => {
    expect(run(101)).toEqual({ action: "hold" });
  });

  it("exits on the stop at the slipped observed price", () => {
    const r = run(98);
    expect(r).toMatchObject({ action: "exit", reason: "stop" });
    expect(r.action === "exit" && r.fill).toBeCloseTo(98 * (1 - 0.0005), 8);
  });

  it("a gap THROUGH the stop fills at the gapped price, not at the stop", () => {
    const r = run(90);
    expect(r.action === "exit" && r.fill).toBeCloseTo(90 * (1 - 0.0005), 8);
    expect(r.action === "exit" && r.fill).toBeLessThan(98);
  });

  it("exits at the target price exactly, with no assumed price improvement", () => {
    expect(run(104)).toEqual({ action: "exit", reason: "target", fill: 104 });
    expect(run(107)).toEqual({ action: "exit", reason: "target", fill: 104 });
  });

  it("flattens at the flat-by time", () => {
    expect(run(101, et(15, 54)).action).toBe("hold");
    expect(run(101, et(15, 55))).toMatchObject({ action: "exit", reason: "time_stop" });
  });

  it("flattens when the session is no longer open (early close, halt, after hours)", () => {
    expect(run(101, et(13, 5), "closed")).toMatchObject({ action: "exit", reason: "session_end" });
    expect(run(101, et(16, 5), "post")).toMatchObject({ action: "exit", reason: "session_end" });
  });

  it("flattens any position left over from a previous session", () => {
    const stale = { ...pos, sessionDate: "2026-07-14" };
    expect(evaluateExit(stale, 101, et(9, 40), "open", DEFAULT_RISK)).toMatchObject({ action: "exit", reason: "session_end" });
  });

  it("stop beats time/session rules when both apply", () => {
    expect(run(97, et(16, 5), "closed")).toMatchObject({ reason: "stop" });
  });

  it("raises the stop to breakeven at +1R, once", () => {
    expect(run(102)).toEqual({ action: "hold", newStop: 100 });
    expect(run(101.99)).toEqual({ action: "hold" });
    const be = { ...pos, stopPrice: 100 };
    expect(evaluateExit(be, 103, et(10, 30), "open", DEFAULT_RISK)).toEqual({ action: "hold" }); // already at breakeven
  });

  it("never moves a stop down, and can be disabled", () => {
    const raised = { ...pos, stopPrice: 101 };
    expect(evaluateExit(raised, 102.5, et(10, 30), "open", DEFAULT_RISK)).toEqual({ action: "hold" });
    expect(run(102, et(10, 30), "open", { ...DEFAULT_RISK, breakevenAtR: 0 })).toEqual({ action: "hold" });
  });

  it("a breakeven stop then exits at about entry", () => {
    const be = { ...pos, stopPrice: 100 };
    const r = evaluateExit(be, 99.9, et(10, 40), "open", DEFAULT_RISK);
    expect(r).toMatchObject({ action: "exit", reason: "stop" });
  });
});
