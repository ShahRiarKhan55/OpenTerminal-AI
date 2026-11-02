import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateFreshness, DEFAULT_POLICY } from "../marketdata/freshness.js";
import { toObservation } from "../marketdata/observation.js";
import * as nasdaq from "./nasdaq.js";

// Shape captured from the live api.nasdaq.com quote endpoint.
const info = (over: Record<string, unknown> = {}, primary: Record<string, unknown> = {}) => ({
  data: {
    symbol: "TST", companyName: "Test Corp", exchange: "NASDAQ-GS", marketStatus: "Market Open", assetClass: "STOCKS",
    primaryData: { lastSalePrice: "$344.70", netChange: "+0.07", percentageChange: "+0.02%", lastTradeTimestamp: "Jul 15, 2026 10:30 AM ET", isRealTime: true,
      bidPrice: "$344.65", askPrice: "$344.74", volume: "367,159", ...primary },
    keyStats: { fiftyTwoWeekHighLow: { value: "243.42 - 351.73" }, dayrange: { value: "NA" } },
    ...over,
  },
  status: { rCode: 200 },
});
const summary = { data: { summaryData: { MarketCap: { value: "5,100,000,000,000" }, AverageVolume: { value: "55,000,000" }, PreviousClose: { value: "$344.63" } } } };
const lookup = (sym: string) => ({ data: [{ symbol: sym, asset: "STOCKS" }] });

function stub(infoBody: unknown | (() => Response), opts: { infoStatus?: number; raw?: string } = {}) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const u = String(url);
    const json = (b: unknown, status = 200) => new Response(typeof opts.raw === "string" && u.includes("/info") ? opts.raw : JSON.stringify(b), { status });
    if (u.includes("slookup")) return json(lookup(u.match(/search=([A-Z]+)/)?.[1] ?? "X"));
    if (u.includes("/summary")) return json(summary);
    if (u.includes("/info")) return json(infoBody, opts.infoStatus ?? 200);
    return json({}, 404);
  }));
}
afterEach(() => vi.unstubAllGlobals());

// Each test uses its own ticker: the provider memoizes asset-class lookups per symbol for the process lifetime.
let n = 0;
const sym = () => "T" + String.fromCharCode(65 + n++ / 26) + String.fromCharCode(65 + (n % 26)) + "Z";

describe("nasdaq.quote parsing of the real payload shape", () => {
  it("parses price, timestamp (DST-aware), delay class and market state", async () => {
    stub(info());
    const q = await nasdaq.quote(sym());
    expect(q).toMatchObject({ price: 344.7, name: "Test Corp", marketState: "Market Open", delayClass: "realtime", source: "nasdaq", bid: 344.65, ask: 344.74 });
    expect(q.time).toBe(Date.UTC(2026, 6, 15, 14, 30) / 1000); // 10:30 ET (EDT) = 14:30Z
    expect(q.marketCap).toBe(5_100_000_000_000);
    expect(q.avgVolume).toBe(55_000_000);
  });

  it("an empty bid/ask (sent outside the session) is unknown, not zero", async () => {
    stub(info({}, { bidPrice: "", askPrice: "  ", volume: "" }));
    const q = await nasdaq.quote(sym());
    expect(q.bid).toBeNull();
    expect(q.ask).toBeNull();
    expect(q.volume).toBeNull();
  });

  it("treats anything not explicitly real-time as delayed", async () => {
    for (const flag of [false, undefined, "true", 1]) {
      stub(info({}, { isRealTime: flag }));
      expect((await nasdaq.quote(sym())).delayClass).toBe("delayed");
    }
  });

  it.each([
    ["N/A price", { lastSalePrice: "N/A" }, "price", null],
    ["empty price", { lastSalePrice: "" }, "price", null],
    ["missing price", { lastSalePrice: undefined }, "price", null],
    ["numeric (not string) price", { lastSalePrice: 344.7 }, "price", null],
    ["missing timestamp", { lastTradeTimestamp: undefined }, "time", null],
    ["garbage timestamp", { lastTradeTimestamp: "DATA UNAVAILABLE" }, "time", null],
    ["impossible date", { lastTradeTimestamp: "Feb 30, 2026 10:30 AM ET" }, "time", null],
    ["numeric timestamp", { lastTradeTimestamp: 1793626620 }, "time", null],
  ])("a corrupted field (%s) yields null, never NaN or a guess", async (_n, primary, field, expected) => {
    stub(info({}, primary));
    const q = await nasdaq.quote(sym());
    expect((q as Record<string, unknown>)[field]).toBe(expected);
  });

  it("corrupted data is then REJECTED by the freshness gate, never accepted as an alert-grade price", async () => {
    const now = Date.UTC(2026, 6, 15, 14, 31);
    const verdict = async (primary: Record<string, unknown>) => {
      stub(info({}, primary));
      return evaluateFreshness(toObservation(await nasdaq.quote(sym())), now, DEFAULT_POLICY).reason;
    };
    expect(await verdict({})).toBe("ok");
    expect(await verdict({ lastSalePrice: "N/A" })).toBe("incomplete");
    expect(await verdict({ lastSalePrice: "$0.00" })).toBe("incomplete");
    expect(await verdict({ lastTradeTimestamp: "garbage" })).toBe("missing_timestamp");
    expect(await verdict({ lastTradeTimestamp: "Jul 15, 2026 10:00 AM ET" })).toBe("stale"); // 31 min old
    expect(await verdict({ lastTradeTimestamp: "Jul 15, 2026 11:45 AM ET" })).toBe("future_timestamp"); // clock skew / bad data
    stub(info({ marketStatus: "Pre-Market" }));
    expect(evaluateFreshness(toObservation(await nasdaq.quote(sym())), now, DEFAULT_POLICY).reason).toBe("market_not_open");
  });

  it("surfaces provider failures as rejections instead of fabricating a quote", async () => {
    stub({}, { infoStatus: 500 });
    await expect(nasdaq.quote(sym())).rejects.toThrow(/nasdaq 500/);
    stub({}, { infoStatus: 429 });
    await expect(nasdaq.quote(sym())).rejects.toThrow(/nasdaq 429/);
    stub({ data: null, status: { rCode: 400 } });
    await expect(nasdaq.quote(sym())).rejects.toThrow(/no data/);
    stub({}, { raw: "<html><body>Access Denied</body></html>" });
    await expect(nasdaq.quote(sym())).rejects.toThrow();
    stub({}, { raw: "" });
    await expect(nasdaq.quote(sym())).rejects.toThrow();
  });
});
