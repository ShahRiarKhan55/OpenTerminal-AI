import { describe, expect, it } from "vitest";
import { easternToEpochMs } from "../marketdata/time.js";
import { makeDb } from "../test-helpers.js";
import {
  closePosition, computeEquity, getAccount, getPosition, InsufficientCashError, listOpenPositions, loadRiskState, markPosition,
  openPosition, raiseStop, resetPaperAccount, statsBetween, type OpenParams,
} from "./paper.js";
import { insertSignal } from "./store.js";

const et = (h: number, m: number, day = 15) => easternToEpochMs(2026, 6, day, h, m)!;
const T = et(10, 30);
const open = (over: Partial<OpenParams> = {}): OpenParams => ({
  signalId: null, symbol: "ABC", strategy: "orb", qty: 50, fillPrice: 100, stop: 98, target: 104, riskPerShare: 2,
  nowMs: T, sessionDate: "2026-07-15", commission: 0, ...over,
});

describe("openPosition", () => {
  it("debits cash by cost + fee and records the entry order", () => {
    const db = makeDb();
    const { id, created } = openPosition(db, open({ commission: 1 }));
    expect(created).toBe(true);
    expect(getAccount(db).cash).toBeCloseTo(100_000 - 5000 - 1, 8);
    const orders = db.prepare("SELECT side, kind, qty, price, fee FROM paper_orders WHERE position_id = ?").all(id);
    expect(orders).toEqual([{ side: "BUY", kind: "entry", qty: 50, price: 100, fee: 1 }]);
    expect(getPosition(db, id)).toMatchObject({ status: "open", qty: 50, entry_price: 100, stop_price: 98, initial_stop: 98, fees: 1 });
  });

  it("is idempotent per signal: a repeat does not double-fill or double-debit", () => {
    const db = makeDb();
    const sig = insertSignal(db, { symbol: "ABC", strategy: "orb", side: "LONG", entry: 100, stop: 98, target: 104, riskPerShare: 2, rewardRisk: 2, validUntilMs: T + 1e6, sessionDate: "2026-07-15", meta: {} }, T)!;
    const a = openPosition(db, open({ signalId: sig.id }));
    const cashAfter = getAccount(db).cash;
    const b = openPosition(db, open({ signalId: sig.id }));
    expect(b).toEqual({ id: a.id, created: false });
    expect(getAccount(db).cash).toBe(cashAfter);
    expect(listOpenPositions(db)).toHaveLength(1);
  });

  it("refuses to spend cash that isn't there, changing nothing", () => {
    const db = makeDb({ cash: 1000 });
    expect(() => openPosition(db, open())).toThrow(InsufficientCashError);
    expect(getAccount(db).cash).toBe(1000);
    expect(listOpenPositions(db)).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) c FROM paper_orders").get()).toEqual({ c: 0 });
  });

  it.each([
    ["zero qty", { qty: 0 }],
    ["fractional qty", { qty: 1.5 }],
    ["negative qty", { qty: -3 }],
    ["stop above fill", { stop: 101 }],
    ["target below fill", { target: 99 }],
    ["zero price", { fillPrice: 0 }],
  ])("rejects %s", (_n, over) => {
    const db = makeDb();
    expect(() => openPosition(db, open(over))).toThrow();
    expect(getAccount(db).cash).toBe(100_000);
  });
});

describe("closePosition", () => {
  it("books P&L, R multiple and cash for a winner", () => {
    const db = makeDb();
    const { id } = openPosition(db, open());
    const row = closePosition(db, id, 104, "target", T + 60_000, 0)!;
    expect(row).toMatchObject({ status: "closed", exit_price: 104, exit_reason: "target", realized_pnl: 200, r_multiple: 2 });
    expect(getAccount(db).cash).toBe(100_200);
  });

  it("a stop at -1R books about -1R", () => {
    const db = makeDb();
    const { id } = openPosition(db, open());
    const row = closePosition(db, id, 98, "stop", T, 0)!;
    expect(row.realized_pnl).toBe(-100);
    expect(row.r_multiple).toBe(-1);
  });

  it("charges commission on both sides", () => {
    const db = makeDb();
    const { id } = openPosition(db, open({ commission: 1 }));
    const row = closePosition(db, id, 104, "target", T, 1)!;
    expect(row.fees).toBe(2);
    expect(row.realized_pnl).toBe(198);
    expect(getAccount(db).cash).toBeCloseTo(100_000 + 200 - 2, 8);
  });

  it("closing twice is harmless", () => {
    const db = makeDb();
    const { id } = openPosition(db, open());
    closePosition(db, id, 104, "target", T, 0);
    const cash = getAccount(db).cash;
    expect(closePosition(db, id, 90, "stop", T, 0)).toBeNull();
    expect(getAccount(db).cash).toBe(cash);
    expect(db.prepare("SELECT COUNT(*) c FROM paper_orders WHERE side = 'SELL'").get()).toEqual({ c: 1 });
  });

  it("returns null for an unknown id and rejects a non-positive fill", () => {
    const db = makeDb();
    expect(closePosition(db, 999, 100, "manual", T, 0)).toBeNull();
    const { id } = openPosition(db, open());
    expect(() => closePosition(db, id, 0, "manual", T, 0)).toThrow();
  });
});

describe("marking and stops", () => {
  it("marks to market and feeds equity", () => {
    const db = makeDb();
    const { id } = openPosition(db, open());
    markPosition(db, id, 103, T + 1000);
    expect(computeEquity(db)).toMatchObject({ cash: 95_000, openValue: 5150, equity: 100_150, unrealizedOpen: 150 });
    markPosition(db, id, -5, T + 2000); // ignored
    markPosition(db, id, NaN, T + 2000); // ignored
    expect(getPosition(db, id)!.last_price).toBe(103);
  });

  it("raiseStop only ever moves the stop up, on open positions", () => {
    const db = makeDb();
    const { id } = openPosition(db, open());
    expect(raiseStop(db, id, 100)).toBe(true);
    expect(raiseStop(db, id, 99)).toBe(false);
    expect(getPosition(db, id)!.stop_price).toBe(100);
    closePosition(db, id, 101, "manual", T, 0);
    expect(raiseStop(db, id, 120)).toBe(false);
    expect(getPosition(db, id)!.initial_stop).toBe(98);
  });
});

describe("loadRiskState", () => {
  it("counts only TODAY's realized P&L and trades, and only stop-outs for cooldowns", () => {
    const db = makeDb();
    // yesterday: a losing stop-out
    const y = openPosition(db, open({ symbol: "OLD", nowMs: et(10, 0, 14), sessionDate: "2026-07-14" }));
    closePosition(db, y.id, 98, "stop", et(11, 0, 14), 0);
    // today: a winner, a stop-out, and one still open
    const w = openPosition(db, open({ symbol: "WIN", nowMs: et(9, 50) }));
    closePosition(db, w.id, 104, "target", et(10, 0), 0);
    const l = openPosition(db, open({ symbol: "LOSE", nowMs: et(10, 5) }));
    closePosition(db, l.id, 98, "stop", et(10, 15), 0);
    const o = openPosition(db, open({ symbol: "HOLD", nowMs: et(10, 20) }));
    markPosition(db, o.id, 101, et(10, 25));

    const s = loadRiskState(db, et(10, 30));
    expect(s.tradesToday).toBe(3);
    expect(s.realizedToday).toBe(200 - 100);
    expect(s.unrealizedOpen).toBe(50);
    expect(s.openSymbols).toEqual(["HOLD"]);
    expect(Object.keys(s.lastStopOutAt).sort()).toEqual(["LOSE", "OLD"]);
    expect(s.lastStopOutAt.WIN).toBeUndefined();
    // equity includes ALL history: -100 (yesterday's stop) + 200 + -100 (today) + 50 unrealized
    expect(s.equity).toBeCloseTo(100_000 - 100 + 200 - 100 + 50, 8);
  });

  it("uses ET day boundaries, not UTC (a 23:30 ET trade belongs to that ET day)", () => {
    const db = makeDb();
    const late = et(23, 30, 15);
    const p = openPosition(db, open({ nowMs: late - 60_000 }));
    closePosition(db, p.id, 104, "target", late, 0); // 03:30 UTC next day
    expect(loadRiskState(db, et(23, 45, 15)).realizedToday).toBe(200);
    expect(loadRiskState(db, et(9, 45, 16)).realizedToday).toBe(0);
  });
});

describe("statsBetween", () => {
  it("summarizes closed trades in the window", () => {
    const db = makeDb();
    for (const [sym, exit] of [["A", 104], ["B", 98], ["C", 104]] as const) {
      const { id } = openPosition(db, open({ symbol: sym }));
      closePosition(db, id, exit, exit > 100 ? "target" : "stop", T + 1000, 0);
    }
    const s = statsBetween(db, T, T + 10_000);
    expect(s).toMatchObject({ closedTrades: 3, wins: 2, losses: 1, totalPnl: 300, best: 200, worst: -100 });
    expect(s.winRate).toBeCloseTo(2 / 3, 10);
    expect(s.avgR).toBeCloseTo((2 - 1 + 2) / 3, 10);
    expect(statsBetween(db, 0, 1)).toMatchObject({ closedTrades: 0, winRate: null, avgR: null, best: null });
  });
});

describe("resetPaperAccount", () => {
  it("restores starting cash and clears positions/orders but keeps signals", () => {
    const db = makeDb();
    insertSignal(db, { symbol: "ABC", strategy: "orb", side: "LONG", entry: 100, stop: 98, target: 104, riskPerShare: 2, rewardRisk: 2, validUntilMs: T + 1e6, sessionDate: "2026-07-15", meta: {} }, T);
    const { id } = openPosition(db, open());
    closePosition(db, id, 90, "stop", T, 0);
    resetPaperAccount(db);
    expect(getAccount(db).cash).toBe(100_000);
    expect(db.prepare("SELECT COUNT(*) c FROM paper_positions").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM paper_orders").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM signals").get()).toEqual({ c: 1 });
  });
});

describe("ledger conservation (randomized, deterministic seed)", () => {
  it("equity always equals starting cash + realized + unrealized, with no cash created or lost", () => {
    const db = makeDb({ cash: 50_000 });
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    let realized = 0;
    for (let i = 0; i < 200; i++) {
      const sym = `S${i % 7}`;
      const fill = 20 + rnd() * 180;
      const open1 = listOpenPositions(db).find((p) => p.symbol === sym);
      if (open1 && rnd() < 0.6) {
        const exit = open1.entry_price * (0.9 + rnd() * 0.25);
        const row = closePosition(db, open1.id, exit, "manual", T + i, 0.5)!;
        realized += row.realized_pnl!;
      } else if (!open1) {
        try {
          openPosition(db, open({ symbol: sym, fillPrice: fill, stop: fill * 0.97, target: fill * 1.06, riskPerShare: fill * 0.03, qty: 1 + Math.floor(rnd() * 20), commission: 0.5, nowMs: T + i }));
        } catch (e) {
          expect(e).toBeInstanceOf(InsufficientCashError);
        }
      }
      for (const p of listOpenPositions(db)) markPosition(db, p.id, p.entry_price * (0.95 + rnd() * 0.1), T + i);
      const eq = computeEquity(db);
      const fees = (db.prepare("SELECT COALESCE(SUM(fee),0) f FROM paper_orders").get() as { f: number }).f;
      const openFees = listOpenPositions(db).reduce((s, p) => s + p.fees, 0);
      // equity = start + realized(net of closed fees) + unrealized - fees paid on still-open entries
      expect(eq.equity).toBeCloseTo(50_000 + realized + eq.unrealizedOpen - openFees, 6);
      expect(fees).toBeGreaterThanOrEqual(0);
      expect(eq.cash).toBeGreaterThanOrEqual(-1e-9);
    }
  });
});
