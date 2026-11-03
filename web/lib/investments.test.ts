import { describe, expect, it } from "vitest";
import {
  buildHoldingPayload, defaultPriceUnit, EMPTY_FORM, formatAge, formatJst, formatPercent, formatPrice, formatSignedYen, formatUnits, formatYen, formFromHolding,
  jstToday, parseDecimal, PRESETS, priceBadge, type FormState, type HoldingDto,
} from "./investments";

describe("parseDecimal (what people actually type)", () => {
  it.each([
    ["1234", 1234], ["1,234,567", 1234567], ["  12.5 ", 12.5], ["¥28,500", 28500], ["28500円", 28500], [".5", 0.5], ["0", 0], ["0.00000001", 0.00000001],
    ["１２３４", 1234], ["１２３，４５６．７", 123456.7], ["¥ 1 000", 1000],
  ])("%j -> %s", (input, expected) => {
    expect(parseDecimal(input)).toEqual({ ok: true, value: expected });
  });
  it.each(["", "   "])("blank %j means no value", (input) => {
    expect(parseDecimal(input)).toEqual({ ok: true, value: null });
  });
  it.each(["abc", "12abc", "1.2.3", "-5", "+5", "1e5", "NaN", "Infinity", "0x10", "--1", "12,,34x", "1/2"])("rejects %j", (input) => {
    expect(parseDecimal(input).ok).toBe(false);
  });
  it("rejects absurdly large numbers instead of returning Infinity", () => {
    expect(parseDecimal("9".repeat(400)).ok).toBe(false);
  });
});

describe("formatting never turns unknown into zero", () => {
  it("yen", () => {
    expect(formatYen(1234567.4)).toBe("¥1,234,567");
    expect(formatYen(1234567.5)).toBe("¥1,234,568");
    expect(formatYen(-9876.6)).toBe("-¥9,877");
    expect(formatYen(0)).toBe("¥0");
    for (const bad of [null, undefined, NaN, Infinity]) expect(formatYen(bad as number)).toBe("—");
  });
  it("signed yen", () => {
    expect(formatSignedYen(1500)).toBe("+¥1,500");
    expect(formatSignedYen(-1500)).toBe("-¥1,500");
    expect(formatSignedYen(0)).toBe("+¥0");
    expect(formatSignedYen(null)).toBe("—");
  });
  it("percent: signed and unsigned, and a tiny negative never shows as '-0.00%'", () => {
    expect(formatPercent(12.3456)).toBe("12.35%");
    expect(formatPercent(12.3456, true)).toBe("+12.35%");
    expect(formatPercent(-3.2, true)).toBe("-3.20%");
    expect(formatPercent(-3.2)).toBe("-3.20%");
    expect(formatPercent(-0.0001, true)).toBe("0.00%");
    expect(formatPercent(0, true)).toBe("0.00%");
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(NaN)).toBe("—");
  });
  it("units keep satoshi precision and drop trailing zeros", () => {
    expect(formatUnits(0.01234567)).toBe("0.01234567");
    expect(formatUnits(1_234_567.5)).toBe("1,234,567.5");
    expect(formatUnits(2)).toBe("2");
    expect(formatUnits(NaN)).toBe("—");
  });
  it("prices", () => {
    expect(formatPrice(28_500)).toBe("¥28,500");
    expect(formatPrice(12_146_016.4)).toBe("¥12,146,016");
    expect(formatPrice(12.5)).toBe("¥12.50");
    expect(formatPrice(null)).toBe("—");
  });
});

describe("Japan-time stamps", () => {
  it("formats in JST regardless of the machine's time zone", () => {
    expect(formatJst(Date.UTC(2026, 10, 3, 3, 0, 0))).toBe("2026-11-03 12:00 JST");
    expect(formatJst(Date.UTC(2026, 10, 2, 15, 0, 0))).toBe("2026-11-03 00:00 JST");
    expect(formatJst(null)).toBe("—");
  });
  it("jstToday rolls over at Japan midnight", () => {
    expect(jstToday(Date.UTC(2026, 10, 2, 14, 59))).toBe("2026-11-02");
    expect(jstToday(Date.UTC(2026, 10, 2, 15, 0))).toBe("2026-11-03");
  });
  it("relative ages", () => {
    const now = 1_000_000_000_000;
    expect([formatAge(now - 5_000, now), formatAge(now - 90_000, now), formatAge(now - 7_300_000, now), formatAge(now - 200_000_000, now), formatAge(null, now)]).toEqual(["5s ago", "1 min ago", "2 h ago", "2 d ago", "unknown time"]);
  });
});

describe("price badges are honest", () => {
  it("missing -> NO PRICE (down), stale -> STALE (amber), live and manual are distinguished", () => {
    expect(priceBadge({ priceStatus: "missing", priceKind: null, quoteIssue: null })).toMatchObject({ text: "NO PRICE", tone: "down" });
    expect(priceBadge({ priceStatus: "stale", priceKind: "manual", quoteIssue: null })).toMatchObject({ text: "STALE", tone: "amber" });
    expect(priceBadge({ priceStatus: "fresh", priceKind: "quote", quoteIssue: null })).toMatchObject({ text: "LIVE", tone: "up" });
    expect(priceBadge({ priceStatus: "fresh", priceKind: "manual", quoteIssue: null })).toMatchObject({ text: "MANUAL", tone: "up" });
  });
  it("carries the server's reason when a quote was rejected", () => {
    expect(priceBadge({ priceStatus: "missing", priceKind: null, quoteIssue: "live quote is in USD, not JPY (ignored)" }).hint).toMatch(/USD, not JPY/);
  });
});

describe("buildHoldingPayload", () => {
  const form = (o: Partial<FormState> = {}): FormState => ({ ...EMPTY_FORM, name: "eMAXIS Slim All Country (オルカン)", units: "1,234,567", avgPrice: "25,000", ...o });
  it("builds the API body: JPY, 10,000-unit NAV basis, numbers parsed", () => {
    const r = buildHoldingPayload(form({ manualPrice: "28,500", manualPriceAsOf: "2026-11-02", notes: " NISA " }));
    expect(r).toEqual({
      ok: true,
      body: { name: "eMAXIS Slim All Country (オルカン)", assetType: "mutual_fund", symbol: null, currency: "JPY", units: 1_234_567, avgPrice: 25_000, priceUnit: 10_000, priceSource: "manual", manualPrice: 28_500, manualPriceAsOf: "2026-11-02", notes: "NISA" },
    });
  });
  it("accepts full-width input and fractional units", () => {
    const r = buildHoldingPayload(form({ units: "０．０１２３", avgPrice: "１１，０００，０００", assetType: "crypto", priceUnit: 1 }));
    expect(r.ok && r.body).toMatchObject({ units: 0.0123, avgPrice: 11_000_000 });
  });
  it("zero units and zero cost are valid; a blank price means 'no price yet'", () => {
    const r = buildHoldingPayload(form({ units: "0", avgPrice: "0" }));
    expect(r).toMatchObject({ ok: true, body: { units: 0, avgPrice: 0, manualPrice: null, manualPriceAsOf: null } });
  });
  it("drops a price date if there is no price", () => {
    expect(buildHoldingPayload(form({ manualPrice: "", manualPriceAsOf: "" }))).toMatchObject({ ok: true, body: { manualPriceAsOf: null } });
  });
  it.each([
    ["a missing name", { name: "  " }, "name"],
    ["blank units", { units: "" }, "units"],
    ["text units", { units: "many" }, "units"],
    ["negative units", { units: "-5" }, "units"],
    ["blank cost", { avgPrice: "" }, "avgPrice"],
    ["a bad price", { manualPrice: "12x" }, "manualPrice"],
    ["a live quote with no symbol", { priceSource: "quote" as const, symbol: "" }, "symbol"],
    ["a malformed date", { manualPrice: "5", manualPriceAsOf: "02/11/2026" }, "manualPriceAsOf"],
    ["a date with no price", { manualPrice: "", manualPriceAsOf: "2026-11-02" }, "manualPrice"],
  ])("reports %s against the right field", (_n, over, field) => {
    const r = buildHoldingPayload(form(over as Partial<FormState>));
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.errors)).toContain(field);
  });
  it("reports every problem at once", () => {
    const r = buildHoldingPayload(form({ name: "", units: "x", avgPrice: "y" }));
    expect(!r.ok && Object.keys(r.errors).sort()).toEqual(["avgPrice", "name", "units"]);
  });
});

describe("presets and defaults", () => {
  it("funds default to the per-10,000 NAV basis; everything else per unit", () => {
    expect(defaultPriceUnit("mutual_fund")).toBe(10000);
    expect(defaultPriceUnit("commodity_fund")).toBe(10000);
    for (const t of ["crypto", "stock", "etf", "other"] as const) expect(defaultPriceUnit(t)).toBe(1);
  });
  it("the three starting-asset presets are configured correctly and contain no invented numbers", () => {
    const by = Object.fromEntries(PRESETS.map((p) => [p.id, p.form]));
    expect(by.orukan).toMatchObject({ assetType: "mutual_fund", priceUnit: 10000, priceSource: "manual" });
    expect(by.gold).toMatchObject({ assetType: "commodity_fund", priceUnit: 10000, priceSource: "manual" });
    expect(by.btc).toMatchObject({ assetType: "crypto", priceUnit: 1, priceSource: "quote", symbol: "BTC-JPY" });
    for (const p of PRESETS) for (const k of ["units", "avgPrice", "manualPrice"] as const) expect(p.form[k]).toBeUndefined();
  });
  it("editing round-trips a holding through the form unchanged", () => {
    const h: HoldingDto = { id: 3, name: "Bitcoin", assetType: "crypto", symbol: "BTC-JPY", currency: "JPY", units: 0.01234567, avgPrice: 11_234_567.89, priceUnit: 1, priceSource: "quote", manualPrice: 11_500_000, manualPriceAsOf: "2026-11-03", manualPriceUpdatedAt: 1, notes: "cold wallet", createdAt: 1, updatedAt: 2 };
    const r = buildHoldingPayload(formFromHolding(h));
    expect(r.ok && r.body).toMatchObject({ name: "Bitcoin", symbol: "BTC-JPY", units: 0.01234567, avgPrice: 11_234_567.89, manualPrice: 11_500_000, manualPriceAsOf: "2026-11-03", notes: "cold wallet", priceSource: "quote" });
  });
});
