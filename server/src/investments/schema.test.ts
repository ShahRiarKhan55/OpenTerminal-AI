import { describe, expect, it } from "vitest";
import { checkAsOfNotFuture, DateKeySchema, HoldingInputSchema, PriceUpdateSchema } from "./schema.js";

const ok = { name: "eMAXIS Slim All Country", assetType: "mutual_fund", currency: "JPY", units: 1_234_567.89, avgPrice: 25_000 };
const parse = (over: Record<string, unknown> = {}) => HoldingInputSchema.safeParse({ ...ok, ...over });
const message = (over: Record<string, unknown>) => {
  const r = parse(over);
  return r.success ? "ACCEPTED" : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" | ");
};

describe("HoldingInputSchema: accepts valid input and fills safe defaults", () => {
  it("minimal holding: manual source, per-unit pricing, no price", () => {
    const r = parse();
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ name: "eMAXIS Slim All Country", priceUnit: 1, priceSource: "manual", manualPrice: null, manualPriceAsOf: null, symbol: null, notes: null });
  });
  it("fractional units are preserved exactly", () => {
    expect(parse({ units: 0.00000001 }).data?.units).toBe(0.00000001);
  });
  it("trims names, upper-cases symbols, treats an empty symbol as none", () => {
    expect(parse({ name: "  Gold Fund  ", symbol: " btc-jpy " }).data).toMatchObject({ name: "Gold Fund", symbol: "BTC-JPY" });
    expect(parse({ symbol: "" }).data?.symbol).toBeNull();
    expect(parse({ symbol: null }).data?.symbol).toBeNull();
  });
  it("accepts the 10,000-unit NAV basis, a price with a date, and a quote source with a symbol", () => {
    expect(parse({ priceUnit: 10_000, manualPrice: 28_500, manualPriceAsOf: "2026-11-02" }).success).toBe(true);
    expect(parse({ assetType: "crypto", priceSource: "quote", symbol: "BTC-JPY" }).success).toBe(true);
  });
  it("zero is a valid amount", () => {
    expect(parse({ units: 0, avgPrice: 0, manualPrice: 0, manualPriceAsOf: "2026-11-02" }).success).toBe(true);
  });
});

describe("HoldingInputSchema: rejects invalid input with a clear message", () => {
  it.each([
    ["an empty name", { name: "" }, /name/],
    ["a blank name", { name: "   " }, /name/],
    ["a 81-character name", { name: "x".repeat(81) }, /name/],
    ["an unknown asset type", { assetType: "nft" }, /assetType/],
    ["a negative unit count", { units: -1 }, /units cannot be negative/],
    ["a negative average price", { avgPrice: -0.01 }, /average purchase price cannot be negative/],
    ["a negative NAV", { manualPrice: -5, manualPriceAsOf: "2026-11-02" }, /cannot be negative/],
    ["an absurd amount", { units: 1e13 }, /unreasonably large/],
    ["units given as a string", { units: "1000" }, /units must be a number/],
    ["null units", { units: null }, /units/],
    ["missing units", { units: undefined }, /units/],
    ["an unsupported currency (USD)", { currency: "USD" }, /currency must be one of: JPY/],
    ["a lower-case currency", { currency: "jpy" }, /currency/],
    ["a price unit of 100", { priceUnit: 100 }, /priceUnit must be 1 or 10000/],
    ["a price unit given as a string", { priceUnit: "10000" }, /priceUnit/],
    ["an unknown price source", { priceSource: "scraper" }, /priceSource/],
    ["a quote source with no symbol", { priceSource: "quote" }, /symbol is required/],
    ["a price date with no price", { manualPriceAsOf: "2026-11-02" }, /without a price/],
    ["a non-date price date", { manualPrice: 1, manualPriceAsOf: "yesterday" }, /date like/],
    ["an impossible calendar date", { manualPrice: 1, manualPriceAsOf: "2026-02-30" }, /real calendar date/],
    ["a symbol with spaces", { symbol: "BTC JPY" }, /symbol may contain/],
    ["a symbol with a path separator", { symbol: "../etc" }, /symbol may contain/],
    ["an SQL-looking symbol", { symbol: "A';DROP TABLE holdings;--" }, /symbol/],
    ["a markup symbol", { symbol: "<script>" }, /symbol/],
    ["a 25-character symbol", { symbol: "A".repeat(25) }, /symbol/],
    ["500+ characters of notes", { notes: "n".repeat(501) }, /notes/],
  ])("rejects %s", (_n, over, re) => {
    expect(message(over as Record<string, unknown>)).toMatch(re);
  });

  it("rejects fields it does not know about instead of silently dropping them", () => {
    expect(message({ brokerPassword: "hunter2" })).toMatch(/Unrecognized key|brokerPassword/i);
    expect(message({ id: 5 })).not.toBe("ACCEPTED");
    expect(message({ createdAt: 1 })).not.toBe("ACCEPTED");
  });
  it("rejects non-object bodies", () => {
    for (const body of [null, undefined, "holding", 42, [], [ok]]) expect(HoldingInputSchema.safeParse(body).success).toBe(false);
  });
  it("never lets a __proto__ payload through", () => {
    expect(HoldingInputSchema.safeParse(JSON.parse('{"__proto__":{"admin":true},"name":"x","assetType":"stock","currency":"JPY","units":1,"avgPrice":1}')).success).toBe(false);
  });
});

describe("PriceUpdateSchema", () => {
  it("accepts a price, optionally dated", () => {
    expect(PriceUpdateSchema.safeParse({ price: 28_500 }).success).toBe(true);
    expect(PriceUpdateSchema.safeParse({ price: 0, asOf: "2026-11-02" }).success).toBe(true);
  });
  it.each([{}, { price: -1 }, { price: "28500" }, { price: null }, { price: 1, asOf: "2026-13-01" }, { price: 1, extra: true }])("rejects %j", (b) => {
    expect(PriceUpdateSchema.safeParse(b).success).toBe(false);
  });
});

describe("dates", () => {
  it("DateKeySchema accepts real dates only (including leap day)", () => {
    for (const d of ["2026-11-03", "2028-02-29"]) expect(DateKeySchema.safeParse(d).success).toBe(true);
    for (const d of ["2026-02-29", "2026-00-10", "2026-11-31", "26-11-03", "2026/11/03", ""]) expect(DateKeySchema.safeParse(d).success).toBe(false);
  });
  it("checkAsOfNotFuture allows today and the past in Japan time but not tomorrow", () => {
    const now = Date.UTC(2026, 10, 3, 3, 0, 0); // 12:00 JST on 2026-11-03
    expect(checkAsOfNotFuture("2026-11-03", now)).toBeNull();
    expect(checkAsOfNotFuture("2026-10-01", now)).toBeNull();
    expect(checkAsOfNotFuture("2026-11-04", now)).toMatch(/future/);
    // 23:30 UTC on Nov 2 is already Nov 3 in Japan
    expect(checkAsOfNotFuture("2026-11-03", Date.UTC(2026, 10, 2, 23, 30))).toBeNull();
  });
});
