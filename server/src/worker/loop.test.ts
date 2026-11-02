import { describe, expect, it, vi } from "vitest";
import { loadWorkerConfig } from "../config.js";
import { at, World } from "./test-world.js";
import { pollDelaySeconds, runLoop, type LoopControl } from "./loop.js";

const cfg = loadWorkerConfig({});
const D = (h: number, m: number, day = 0) => at(h, m, 0, day);

describe("pollDelaySeconds", () => {
  it("polls fast in and around the session, slowly otherwise", () => {
    expect(pollDelaySeconds({ cfg }, D(10, 0), 0)).toBe(60);
    expect(pollDelaySeconds({ cfg }, D(9, 15), 0)).toBe(60);
    expect(pollDelaySeconds({ cfg }, D(16, 30), 0)).toBe(60);
    expect(pollDelaySeconds({ cfg }, D(9, 14), 0)).toBe(300);
    expect(pollDelaySeconds({ cfg }, D(16, 31), 0)).toBe(300);
    expect(pollDelaySeconds({ cfg }, D(10, 0, 3), 0)).toBe(300); // Saturday
  });
  it("backs off exponentially after failures, capped at 5 minutes", () => {
    expect([1, 2, 3, 4, 5, 9].map((f) => pollDelaySeconds({ cfg }, D(10, 0), f))).toEqual([120, 240, 300, 300, 300, 300]);
  });
  it("respects a configured interval", () => {
    expect(pollDelaySeconds({ cfg: loadWorkerConfig({ MONITOR_POLL_SECONDS: "30" }) }, D(10, 0), 0)).toBe(30);
  });
});

describe("runLoop", () => {
  const run = async (w: World, ticks: number, opts: Parameters<typeof runLoop>[3] = {}) => {
    const ctl: LoopControl = { stopped: false };
    const sleeps: number[] = [];
    let done = 0;
    const origQuotes = w.deps.source.quotes;
    w.deps.source.quotes = async (s) => {
      if (++done >= ticks) ctl.stopped = true;
      return origQuotes(s);
    };
    w.deps.sleep = async (ms) => {
      sleeps.push(ms);
      w.t += ms;
    };
    w.t = D(10, 0);
    await runLoop(w.deps, w.rt, ctl, { random: () => 0.5, ...opts });
    return { sleeps, ticks: w.rt.tickCount };
  };

  it("runs the requested number of ticks and stops promptly when told to", async () => {
    const w = new World();
    const r = await run(w, 3);
    expect(r.ticks).toBe(3);
  });

  it("sleeps in slices of at most one second so shutdown is prompt", async () => {
    const w = new World();
    const { sleeps } = await run(w, 2);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(1000);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(59_000); // ~one 60s poll interval between ticks
  });

  it("keeps going after a tick that throws outright, and backs off", async () => {
    const w = new World();
    const real = w.deps.db;
    let calls = 0;
    // loadRiskConfig is the first thing a tick does with the database: make it blow up twice.
    w.deps.db = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("FROM settings") && calls < 2) {
              calls++;
              throw new Error("disk I/O error");
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const ctl: LoopControl = { stopped: false };
    const sleeps: number[] = [];
    w.deps.sleep = async (ms) => {
      sleeps.push(ms);
      w.t += ms;
      if (w.rt.tickCount >= 4) ctl.stopped = true;
    };
    w.t = D(10, 0);
    await runLoop(w.deps, w.rt, ctl, { random: () => 0.5 });
    expect(w.rt.tickCount).toBeGreaterThanOrEqual(4);
    expect(w.rt.errorCount).toBeGreaterThanOrEqual(2);
    expect(w.rt.lastError).toContain("tick");
    // waits after the two failures were backed off (120s then 240s), not the normal 60s
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(120_000 + 240_000 - 2000);
  });

  it("never runs two ticks at once, even when a tick is slow", async () => {
    const w = new World();
    let active = 0;
    let maxActive = 0;
    const orig = w.deps.source.quotes;
    w.deps.source.quotes = async (s) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return orig(s);
    };
    const r = await run(w, 4);
    expect(maxActive).toBe(1);
    expect(r.ticks).toBe(4);
  });

  it("declares a hung tick fatal (so the supervisor restarts the process) instead of piling up work", async () => {
    const w = new World();
    w.deps.source.quotes = () => new Promise(() => {}); // never settles
    const onFatal = vi.fn();
    const ctl: LoopControl = { stopped: false };
    w.deps.sleep = async () => {};
    await runLoop(w.deps, w.rt, ctl, { tickTimeoutMs: 40, onFatal });
    expect(onFatal).toHaveBeenCalledOnce();
    expect(w.rt.tickCount).toBe(1); // no second tick was started on top of the hung one
    expect(w.count("audit_log", "decision = 'tick_timeout'")).toBe(1);
  });

  it("a slow-but-finishing tick over the limit is tolerated once it settles", async () => {
    const w = new World();
    const orig = w.deps.source.quotes;
    let first = true;
    w.deps.source.quotes = async (s) => {
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 70));
      }
      return orig(s);
    };
    const onFatal = vi.fn();
    const r = await run(w, 3, { tickTimeoutMs: 40, onFatal });
    expect(onFatal).not.toHaveBeenCalled();
    expect(r.ticks).toBeGreaterThanOrEqual(2);
  });
});
