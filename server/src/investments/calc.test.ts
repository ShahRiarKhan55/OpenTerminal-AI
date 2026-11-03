import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY, jstDateKey, jstDayStartMs, manualPriceTimeMs, summarize, valueHolding, type Holding, type HoldingValuation, type QuoteReading,
} from "./calc.js";

const NOW = Date.UTC(2026, 10, 3, 3, 0, 0); // 2026-11-03 12:00 JST
const H = 3_600_000;
const MIN = 60_000;

const holding = (over: Partial<Holding> = {}): Holding => ({
  id: 1, name: "Test", assetType: "stock", symbol: null, currency: "JPY", units: 1000, avgPrice: 100, priceUnit: 1, priceSource: "manual",
  manualPrice: 120, manualPriceAsOf: "2026-11-03", manualPriceUpdatedAt: NOW - 2 * H, notes: null, createdAt: 0, updatedAt: 0, ...over,
});
const quote = (over: Partial<QuoteReading> = {}): QuoteReading => ({ symbol: "BTC-JPY", price: 12_000_000, currency: "JPY", timeMs: NOW - 30_000, source: "yahoo", servedStale: false, ...over });
const val = (over: Partial<Holding> = {}, q: QuoteReading | null = null, now = NOW) => valueHolding(holding(over), q, now);

describe("market value, cost basis and P/L", () => {
  it("market value = units x price, cost = units x average price, P/L = value - cost", () => {
    const v = val({ units: 1000, avgPrice: 100, manualPrice: 120 });
    expect(v.costBasis).toBe(100_000);
    expect(v.marketValue).toBe(120_000);
    expect(v.unrealizedPnl).toBe(20_000);
    expect(v.unrealizedPct).toBeCloseTo(20, 10);
    expect(v).toMatchObject({ priceStatus: "fresh", priceKind: "manual", invalid: false });
  });

  it("handles fractional units (crypto)", () => {
    const v = val({ assetType: "crypto", units: 0.0123456789, avgPrice: 11_000_000, manualPrice: 12_146_016 });
    expect(v.costBasis).toBeCloseTo(0.0123456789 * 11_000_000, 6);
    expect(v.marketValue).toBeCloseTo(0.0123456789 * 12_146_016, 6);
    expect(v.unrealizedPct).toBeCloseTo((12_146_016 / 11_000_000 - 1) * 100, 8);
  });

  it("does not drift on classic floating-point traps (0.1 + 0.2 units)", () => {
    const s = summarize([val({ id: 1, units: 0.1, avgPrice: 10, manualPrice: 10 }), val({ id: 2, units: 0.2, avgPrice: 10, manualPrice: 10 })]);
    expect(s.marketValue).toBeCloseTo(3, 12);
    expect(s.unrealizedPnl).toBeCloseTo(0, 12);
  });

  describe("Japanese mutual-fund NAV is quoted per 10,000 units", () => {
    it("divides by the price unit: 1,234,567 units, cost NAV 25,000, today's NAV 28,000", () => {
      const v = val({ assetType: "mutual_fund", priceUnit: 10_000, units: 1_234_567, avgPrice: 25_000, manualPrice: 28_000 });
      expect(v.costBasis).toBeCloseTo(3_086_417.5, 4);
      expect(v.marketValue).toBeCloseTo(3_456_787.6, 4);
      expect(v.unrealizedPct).toBeCloseTo(12, 10); // 28,000 / 25,000 - 1
    });
    it("would be wrong by exactly 10,000x without the unit (guards the default)", () => {
      const per1 = val({ units: 1_234_567, avgPrice: 25_000, manualPrice: 28_000, priceUnit: 1 });
      const per10k = val({ units: 1_234_567, avgPrice: 25_000, manualPrice: 28_000, priceUnit: 10_000 });
      expect(per1.marketValue! / per10k.marketValue!).toBeCloseTo(10_000, 6);
      expect(per1.unrealizedPct).toBeCloseTo(per10k.unrealizedPct!, 10); // percentage is unit-independent
    });
  });

  describe("zero values", () => {
    it("zero units: zero cost and value, and an UNDEFINED (null) percentage rather than 0/NaN/Infinity", () => {
      const v = val({ units: 0 });
      expect(v).toMatchObject({ costBasis: 0, marketValue: 0, unrealizedPnl: 0, unrealizedPct: null });
    });
    it("zero average price (e.g. a gift): P/L equals value, percentage undefined", () => {
      const v = val({ avgPrice: 0, units: 10, manualPrice: 50 });
      expect(v).toMatchObject({ costBasis: 0, marketValue: 500, unrealizedPnl: 500, unrealizedPct: null });
    });
    it("a price of exactly zero is a real (total-loss) price, not a missing one", () => {
      const v = val({ manualPrice: 0 });
      expect(v.priceStatus).toBe("fresh");
      expect(v.marketValue).toBe(0);
      expect(v.unrealizedPct).toBeCloseTo(-100, 10);
    });
  });

  it("reports a loss with the right sign and percentage", () => {
    const v = val({ units: 200, avgPrice: 500, manualPrice: 400 });
    expect(v.unrealizedPnl).toBe(-20_000);
    expect(v.unrealizedPct).toBeCloseTo(-20, 10);
  });
});

describe("missing prices are never invented", () => {
  it("no manual price and no quote -> status missing, no value, no P/L, but cost is still known", () => {
    const v = val({ manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null });
    expect(v).toMatchObject({ price: null, priceStatus: "missing", priceKind: null, marketValue: null, unrealizedPnl: null, unrealizedPct: null, costBasis: 100_000 });
  });
  it("never substitutes the purchase price for a missing price", () => {
    const v = val({ manualPrice: null, avgPrice: 777 });
    expect(v.marketValue).toBeNull();
    expect(v.price).toBeNull();
  });
});

describe("manual price staleness", () => {
  it("a NAV dated today (entered 2 h ago) is fresh and dates from the moment it was typed", () => {
    expect(manualPriceTimeMs(holding())).toBe(NOW - 2 * H);
    expect(val().priceStatus).toBe("fresh");
  });
  it("a NAV for an earlier day dates from the start of that day (JST)", () => {
    const h = holding({ manualPriceAsOf: "2026-10-30", manualPriceUpdatedAt: NOW - H });
    expect(manualPriceTimeMs(h)).toBe(jstDayStartMs("2026-10-30"));
  });
  it("funds: last Friday's NAV viewed on Tuesday noon (84 h) is fresh; a NAV from 108 h ago is stale", () => {
    // (NAV dates are judged from the START of that Japan-time day because the price was typed in later.)
    expect(val({ assetType: "mutual_fund", manualPriceAsOf: "2026-10-31", manualPriceUpdatedAt: NOW - H }).priceStatus).toBe("fresh");
    const stale = val({ assetType: "mutual_fund", manualPriceAsOf: "2026-10-30", manualPriceUpdatedAt: NOW - H });
    expect(stale.priceStatus).toBe("stale");
    expect(stale.marketValue).not.toBeNull(); // still shown, but flagged
  });
  it("crypto: a hand-typed price is stale after 24 h", () => {
    const at = (hoursAgo: number) => holding({ assetType: "crypto", manualPriceAsOf: jstDateKey(NOW - hoursAgo * H), manualPriceUpdatedAt: NOW - hoursAgo * H });
    expect(valueHolding(at(23), null, NOW).priceStatus).toBe("fresh");
    expect(valueHolding(at(25), null, NOW).priceStatus).toBe("stale");
  });
  it("the boundary is exact: 96 h is fresh, 96 h + 1 ms is stale", () => {
    const edge = (ageMs: number) => {
      const t = NOW - ageMs;
      return valueHolding(holding({ assetType: "mutual_fund", manualPriceAsOf: jstDateKey(t), manualPriceUpdatedAt: t }), null, NOW).priceStatus;
    };
    expect(edge(96 * H)).toBe("fresh");
    expect(edge(96 * H + 1)).toBe("stale");
  });
  it("a NAV dated in the future is never fresh", () => {
    expect(val({ manualPriceAsOf: "2026-11-09", manualPriceUpdatedAt: NOW }).priceStatus).toBe("stale");
  });
  it("a manual price with no usable date cannot be proven fresh", () => {
    expect(val({ manualPriceAsOf: null, manualPriceUpdatedAt: null }).priceStatus).toBe("stale");
  });
});

describe("live quotes (BTC-JPY)", () => {
  const btc = (over: Partial<Holding> = {}) => holding({ assetType: "crypto", symbol: "BTC-JPY", priceSource: "quote", units: 0.5, avgPrice: 10_000_000, manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null, ...over });
  const v = (h: Holding, q: QuoteReading | null) => valueHolding(h, q, NOW);

  it("uses a fresh live quote", () => {
    const r = v(btc(), quote());
    expect(r).toMatchObject({ priceStatus: "fresh", priceKind: "quote", price: 12_000_000, marketValue: 6_000_000, unrealizedPnl: 1_000_000, quoteIssue: null });
    expect(r.priceLabel).toBe("yahoo");
  });
  it("a quote older than 15 minutes is stale (flagged), and the reason is stated", () => {
    const r = v(btc(), quote({ timeMs: NOW - 16 * MIN }));
    expect(r.priceStatus).toBe("stale");
    expect(r.quoteIssue).toMatch(/too old/);
    expect(r.marketValue).toBe(6_000_000);
  });
  it("a quote exactly at the age limit is fresh; one ms over is not", () => {
    expect(v(btc(), quote({ timeMs: NOW - DEFAULT_POLICY.quoteMaxAgeMs })).priceStatus).toBe("fresh");
    expect(v(btc(), quote({ timeMs: NOW - DEFAULT_POLICY.quoteMaxAgeMs - 1 })).priceStatus).toBe("stale");
  });
  it("a quote with no timestamp, a future timestamp, or a last-known fallback is never 'fresh'", () => {
    expect(v(btc(), quote({ timeMs: null })).priceStatus).toBe("stale");
    expect(v(btc(), quote({ timeMs: NOW + 10 * MIN })).priceStatus).toBe("stale");
    expect(v(btc(), quote({ servedStale: true })).priceStatus).toBe("stale");
    expect(v(btc(), quote({ servedStale: true })).quoteIssue).toMatch(/last-known fallback/);
  });

  describe("a quote is only accepted if it is verifiably the same instrument in the same currency", () => {
    it("REJECTS a quote in another currency: this is the BTC -> US ETF mis-resolution guard", () => {
      const r = v(btc(), quote({ currency: "USD", symbol: "BTC-JPY", price: 33.85 }));
      expect(r.price).toBeNull();
      expect(r.priceStatus).toBe("missing");
      expect(r.quoteIssue).toMatch(/USD, not JPY/);
    });
    it("rejects a quote for a different symbol", () => {
      const r = v(btc(), quote({ symbol: "BTC", price: 33.85 }));
      expect(r.priceStatus).toBe("missing");
      expect(r.quoteIssue).toMatch(/not BTC-JPY/);
    });
    it("rejects a quote that does not state its currency (cannot be verified)", () => {
      expect(v(btc(), quote({ currency: null })).priceStatus).toBe("missing");
    });
    it.each([0, -5, NaN, null])("rejects a quote price of %s", (price) => {
      expect(v(btc(), quote({ price: price as number | null })).priceStatus).toBe("missing");
    });
    it("matches symbol and currency case-insensitively", () => {
      expect(v(btc(), quote({ symbol: "btc-jpy", currency: "jpy" })).priceStatus).toBe("fresh");
    });
  });

  describe("manual entry always works, even when the provider fails", () => {
    const withManual = (over: Partial<Holding> = {}) => btc({ manualPrice: 11_500_000, manualPriceAsOf: "2026-11-03", manualPriceUpdatedAt: NOW - 10 * MIN, ...over });
    it("provider down: falls back to the fresh manual price and says so", () => {
      const r = v(withManual(), null);
      expect(r).toMatchObject({ priceStatus: "fresh", priceKind: "manual", price: 11_500_000 });
      expect(r.quoteIssue).toMatch(/unavailable/);
    });
    it("wrong-currency quote: falls back to manual", () => {
      expect(v(withManual(), quote({ currency: "USD" })).priceKind).toBe("manual");
    });
    it("stale quote but fresh manual: the fresh manual price wins", () => {
      const r = v(withManual(), quote({ timeMs: NOW - 2 * H }));
      expect(r).toMatchObject({ priceKind: "manual", priceStatus: "fresh" });
    });
    it("fresh quote and fresh manual: the more recent one wins; a tie goes to the quote", () => {
      expect(v(withManual({ manualPriceUpdatedAt: NOW - 60_000 }), quote({ timeMs: NOW - 5 * MIN })).priceKind).toBe("manual");
      expect(v(withManual(), quote({ timeMs: NOW - 30_000 })).priceKind).toBe("quote");
      expect(v(withManual({ manualPriceUpdatedAt: NOW - 30_000 }), quote({ timeMs: NOW - 30_000 })).priceKind).toBe("quote");
    });
    it("both stale: shows the most recent, flagged stale", () => {
      const r = v(withManual({ manualPriceAsOf: "2026-10-20", manualPriceUpdatedAt: NOW - 10 * 24 * H }), quote({ timeMs: NOW - 3 * H }));
      expect(r.priceStatus).toBe("stale");
      expect(r.priceKind).toBe("quote");
    });
    it("with a symbol-less quote holding the reason is explicit", () => {
      expect(v(btc({ symbol: null }), null).quoteIssue).toMatch(/no symbol/);
    });
  });

  it("a manual-source holding ignores any quote entirely", () => {
    const r = valueHolding(holding({ symbol: "BTC-JPY", priceSource: "manual", manualPrice: 100 }), quote(), NOW);
    expect(r).toMatchObject({ priceKind: "manual", price: 100 });
  });
});

describe("invalid holding data is contained, never propagated", () => {
  it.each([
    ["negative units", { units: -1 }],
    ["NaN units", { units: NaN }],
    ["Infinity avg price", { avgPrice: Infinity }],
    ["negative avg price", { avgPrice: -5 }],
    ["bad price unit", { priceUnit: 7 as never }],
  ])("%s -> invalid, no amounts", (_n, over) => {
    const r = val(over);
    expect(r).toMatchObject({ invalid: true, marketValue: null, unrealizedPnl: null, costBasis: 0 });
  });
  it("a corrupt manual price is ignored, not used", () => {
    expect(val({ manualPrice: NaN }).priceStatus).toBe("missing");
    expect(val({ manualPrice: -1 }).priceStatus).toBe("missing");
  });
});

describe("summarize: totals, percentages and allocation", () => {
  const fund = val({ id: 1, name: "オルカン", assetType: "mutual_fund", priceUnit: 10_000, units: 2_000_000, avgPrice: 25_000, manualPrice: 30_000 }); // cost 5,000,000 -> 6,000,000
  const gold = val({ id: 2, name: "Gold Fund", assetType: "commodity_fund", priceUnit: 10_000, units: 1_000_000, avgPrice: 20_000, manualPrice: 19_000 }); // cost 2,000,000 -> 1,900,000
  const btcV = val({ id: 3, name: "Bitcoin", assetType: "crypto", units: 0.1, avgPrice: 9_000_000, manualPrice: 12_000_000 }); // cost 900,000 -> 1,200,000

  it("computes total value, invested cost, P/L and percentage for the whole portfolio", () => {
    const s = summarize([fund, gold, btcV]);
    expect(s.marketValue).toBeCloseTo(9_100_000, 6);
    expect(s.totalCost).toBeCloseTo(7_900_000, 6);
    expect(s.unrealizedPnl).toBeCloseTo(1_200_000, 6);
    expect(s.unrealizedPct).toBeCloseTo((1_200_000 / 7_900_000) * 100, 10);
    expect(s).toMatchObject({ baseCurrency: "JPY", complete: true, hasStale: false, pricedCount: 3, missingCount: 0, warnings: [] });
  });
  it("allocation is by value, largest first, and sums to 100%", () => {
    const s = summarize([gold, btcV, fund]);
    expect(s.allocation.map((a) => a.name)).toEqual(["オルカン", "Gold Fund", "Bitcoin"]);
    expect(s.allocation[0].pct).toBeCloseTo((6_000_000 / 9_100_000) * 100, 10);
    expect(s.allocation.reduce((t, a) => t + (a.pct ?? 0), 0)).toBeCloseTo(100, 10);
  });

  it("an unpriced holding is excluded from value and P/L (not valued at cost) and the totals are flagged incomplete", () => {
    const nothing = val({ id: 4, name: "No price", units: 100, avgPrice: 1000, manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null });
    const s = summarize([fund, nothing]);
    expect(s.marketValue).toBeCloseTo(6_000_000, 6);
    expect(s.totalCost).toBeCloseTo(5_100_000, 6); // invested cost still counts everything held
    expect(s.pricedCost).toBeCloseTo(5_000_000, 6);
    expect(s.unrealizedPnl).toBeCloseTo(1_000_000, 6); // like-for-like: only priced holdings
    expect(s.unrealizedPct).toBeCloseTo(20, 10);
    expect(s).toMatchObject({ complete: false, missingCount: 1, pricedCount: 1 });
    expect(s.allocation.map((a) => a.name)).toEqual(["オルカン"]);
    expect(s.warnings.join(" ")).toMatch(/no price.*incomplete/);
  });

  it("stale prices stay in the totals but are counted and warned about", () => {
    const stale = val({ id: 5, assetType: "mutual_fund", manualPriceAsOf: "2026-10-20", manualPriceUpdatedAt: NOW - 14 * 24 * H });
    const s = summarize([fund, stale]);
    expect(s).toMatchObject({ hasStale: true, staleCount: 1, complete: true });
    expect(s.warnings.join(" ")).toMatch(/stale/);
  });

  describe("degenerate portfolios never produce NaN or Infinity", () => {
    const allFinite = (s: ReturnType<typeof summarize>) => {
      for (const n of [s.marketValue, s.totalCost, s.pricedCost, s.unrealizedPnl]) expect(Number.isFinite(n)).toBe(true);
      for (const n of [s.unrealizedPct, ...s.allocation.map((a) => a.pct)]) if (n !== null) expect(Number.isFinite(n)).toBe(true);
    };
    it("empty", () => {
      const s = summarize([]);
      expect(s).toMatchObject({ marketValue: 0, totalCost: 0, unrealizedPnl: 0, unrealizedPct: null, allocation: [], complete: true });
      allFinite(s);
    });
    it("everything unpriced", () => {
      const s = summarize([val({ manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null })]);
      expect(s).toMatchObject({ marketValue: 0, unrealizedPct: null, allocation: [], complete: false });
      allFinite(s);
    });
    it("everything worth zero: allocation percentages are undefined, not 0/0", () => {
      const s = summarize([val({ manualPrice: 0 }), val({ id: 2, manualPrice: 0 })]);
      expect(s.marketValue).toBe(0);
      expect(s.allocation.every((a) => a.pct === null)).toBe(true);
      allFinite(s);
    });
    it("zero cost across the board: P/L percentage undefined", () => {
      const s = summarize([val({ avgPrice: 0 })]);
      expect(s.unrealizedPct).toBeNull();
      allFinite(s);
    });
  });

  it("property: for random portfolios totals equal the sum of parts and allocation sums to 100%", () => {
    let seed = 20261103;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let round = 0; round < 200; round++) {
      const vals: HoldingValuation[] = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) =>
        val({ id: i + 1, units: rnd() * 1e6, avgPrice: rnd() * 5e4, manualPrice: rnd() < 0.15 ? null : rnd() * 5e4, priceUnit: rnd() < 0.5 ? 1 : 10_000, assetType: "stock",
          manualPriceAsOf: rnd() < 0.15 ? null : "2026-11-03", manualPriceUpdatedAt: NOW - 1000 })
      );
      const s = summarize(vals);
      const priced = vals.filter((v) => v.marketValue !== null);
      expect(s.marketValue).toBeCloseTo(priced.reduce((t, v) => t + v.marketValue!, 0), 3);
      expect(s.totalCost).toBeCloseTo(vals.reduce((t, v) => t + v.costBasis, 0), 3);
      expect(s.pricedCount + s.missingCount).toBe(vals.length);
      if (s.marketValue > 0) expect(s.allocation.reduce((t, a) => t + (a.pct ?? 0), 0)).toBeCloseTo(100, 8);
      expect(Number.isNaN(s.unrealizedPnl)).toBe(false);
    }
  });
});

describe("currency integrity: amounts in different currencies are never silently added", () => {
  const yen = val({ id: 1, name: "Yen asset", units: 10, avgPrice: 1000, manualPrice: 1100 }); // 10,000 -> 11,000
  // A USD holding can only exist here by bypassing the API (which accepts JPY only), which is exactly the case to defend.
  const usd = val({ id: 2, name: "Dollar asset", currency: "USD", units: 10, avgPrice: 100, manualPrice: 110 }); // 1,000 -> 1,100 USD

  it("excludes a USD holding from JPY totals and says why (no FX rate)", () => {
    const s = summarize([yen, usd]);
    expect(s.marketValue).toBe(11_000);
    expect(s.totalCost).toBe(10_000);
    expect(s.excluded).toEqual([expect.objectContaining({ id: 2, currency: "USD", reason: expect.stringMatching(/no FX rate to JPY/) })]);
    expect(s.allocation.map((a) => a.id)).toEqual([1]);
    expect(s.warnings.join(" ")).toMatch(/not included in JPY totals/);
  });
  it("the naive sum (11,000 + 1,100) is never produced", () => {
    expect(summarize([yen, usd]).marketValue).not.toBe(12_100);
  });
  it("converts only with an explicit, fresh FX rate", () => {
    const s = summarize([yen, usd], { nowMs: NOW, fxRates: { USD: { rate: 150, asOfMs: NOW - H } } });
    expect(s.marketValue).toBeCloseTo(11_000 + 1_100 * 150, 6);
    expect(s.totalCost).toBeCloseTo(10_000 + 1_000 * 150, 6);
    expect(s.excluded).toEqual([]);
  });
  it.each([
    ["a stale rate (25 h old)", { rate: 150, asOfMs: NOW - 25 * H }],
    ["a zero rate", { rate: 0, asOfMs: NOW }],
    ["a negative rate", { rate: -150, asOfMs: NOW }],
    ["a NaN rate", { rate: NaN, asOfMs: NOW }],
    ["a rate dated in the future", { rate: 150, asOfMs: NOW + H }],
  ])("refuses %s", (_n, fx) => {
    const s = summarize([yen, usd], { nowMs: NOW, fxRates: { USD: fx } });
    expect(s.marketValue).toBe(11_000);
    expect(s.excluded).toHaveLength(1);
  });
  it("refuses any FX rate when the clock is not supplied (cannot judge its age)", () => {
    expect(summarize([yen, usd], { fxRates: { USD: { rate: 150, asOfMs: NOW } } }).marketValue).toBe(11_000);
  });
  it("a rate for a DIFFERENT currency is not applied", () => {
    expect(summarize([yen, usd], { nowMs: NOW, fxRates: { EUR: { rate: 160, asOfMs: NOW } } }).marketValue).toBe(11_000);
  });
  it("excludes invalid holdings from totals and lists them", () => {
    const bad = val({ id: 9, units: -1 });
    const s = summarize([yen, bad]);
    expect(s.marketValue).toBe(11_000);
    expect(s.excluded[0]).toMatchObject({ id: 9, reason: "invalid holding data" });
  });
  it("currency codes compare case-insensitively against the base", () => {
    expect(summarize([val({ currency: "jpy" })]).excluded).toEqual([]);
  });
});

describe("JST helpers", () => {
  it("jstDateKey uses Japan's calendar date", () => {
    expect(jstDateKey(Date.UTC(2026, 10, 2, 15, 0, 0))).toBe("2026-11-03"); // 00:00 JST
    expect(jstDateKey(Date.UTC(2026, 10, 2, 14, 59, 59))).toBe("2026-11-02");
  });
  it("jstDayStartMs rejects malformed input", () => {
    expect(jstDayStartMs("2026-11-03")).toBe(Date.UTC(2026, 10, 2, 15, 0, 0));
    for (const bad of ["", "2026-1-3", "tomorrow", "2026-11-03T00:00"]) expect(jstDayStartMs(bad)).toBeNull();
  });
});
