import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "../providers/yahoo.js";

vi.mock("../marketdata/quotes.js", async (orig) => ({ ...(await orig<object>()), getQuotes: vi.fn() }));
import { getQuotes } from "../marketdata/quotes.js";
const mockQuotes = vi.mocked(getQuotes);

const KEY = "investments-test-key-0123456789";
let tmpDir: string;
let server: Server;
let base: string;
let db: (typeof import("../db.js"))["db"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ot-invest-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.API_KEY = KEY;
  const { createApp } = await import("../app.js");
  ({ db } = await import("../db.js"));
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.API_KEY;
});
beforeEach(() => {
  db.prepare("DELETE FROM holdings").run();
  mockQuotes.mockReset();
  mockQuotes.mockResolvedValue([]);
});

async function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers["x-api-key"] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const FUND = { name: "eMAXIS Slim All Country", assetType: "mutual_fund", currency: "JPY", units: 2_000_000, avgPrice: 25_000, priceUnit: 10_000 };
const today = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const create = async (over: Record<string, unknown> = {}) => (await call("POST", "/api/holdings", { ...FUND, ...over })).json;
const q = (over: Partial<Quote> = {}) => ({ symbol: "BTC-JPY", price: 12_000_000, currency: "JPY", time: Math.floor(Date.now() / 1000) - 20, source: "yahoo", ...over }) as unknown as Quote;

describe("authorization: every investments endpoint requires the API key", () => {
  const endpoints: [string, string][] = [
    ["GET", "/api/holdings"], ["POST", "/api/holdings"], ["PUT", "/api/holdings/1"], ["DELETE", "/api/holdings/1"],
    ["POST", "/api/holdings/1/price"], ["GET", "/api/investments/summary"],
  ];
  it.each(endpoints)("%s %s -> 401 without a key", async (method, path) => {
    expect((await call(method, path, ["POST", "PUT"].includes(method) ? {} : undefined, null)).status).toBe(401);
  });
  it.each(endpoints)("%s %s -> 401 with a wrong key", async (method, path) => {
    expect((await call(method, path, ["POST", "PUT"].includes(method) ? {} : undefined, "wrong-key")).status).toBe(401);
  });
  it("a request that only looks like the prefix is not routed into it", async () => {
    expect((await call("GET", "/api/holdingsx", undefined, null)).status).toBe(404);
  });
});

describe("adding, listing, editing and deleting holdings", () => {
  it("starts empty and advertises the base currency", async () => {
    const r = await call("GET", "/api/holdings");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ holdings: [], baseCurrency: "JPY", supportedCurrencies: ["JPY"] });
  });
  it("creates the three starting assets", async () => {
    const a = await call("POST", "/api/holdings", { ...FUND, manualPrice: 30_000, manualPriceAsOf: today() });
    const b = await call("POST", "/api/holdings", { name: "Gold Fund", assetType: "commodity_fund", currency: "JPY", units: 1_000_000, avgPrice: 20_000, priceUnit: 10_000 });
    const c = await call("POST", "/api/holdings", { name: "Bitcoin", assetType: "crypto", currency: "JPY", symbol: "btc-jpy", priceSource: "quote", units: 0.0123, avgPrice: 11_000_000 });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);
    expect(c.json).toMatchObject({ symbol: "BTC-JPY", priceSource: "quote", units: 0.0123 });
    expect((await call("GET", "/api/holdings")).json.holdings.map((h: { name: string }) => h.name)).toEqual(["eMAXIS Slim All Country", "Gold Fund", "Bitcoin"]);
  });

  it.each([
    ["USD currency (unsupported in Phase 1)", { currency: "USD" }, /currency must be one of: JPY/],
    ["negative units", { units: -1 }, /units cannot be negative/],
    ["string units", { units: "5" }, /units must be a number/],
    ["a quote source without a symbol", { priceSource: "quote" }, /symbol is required/],
    ["an unknown field", { apiKey: "secret" }, /Unrecognized key|apiKey/],
    ["a future NAV date", { manualPrice: 1, manualPriceAsOf: "2999-01-01" }, /future/],
    ["a price unit of 5", { priceUnit: 5 }, /priceUnit/],
  ])("rejects %s with 400 and says why", async (_n, over, re) => {
    const r = await call("POST", "/api/holdings", { ...FUND, ...over });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.json)).toMatch(re);
    expect((await call("GET", "/api/holdings")).json.holdings).toHaveLength(0);
  });
  it("rejects malformed JSON and non-objects cleanly", async () => {
    const bad = await fetch(`${base}/api/holdings`, { method: "POST", headers: { "x-api-key": KEY, "content-type": "application/json" }, body: "{oops" });
    expect(bad.status).toBe(400);
    expect((await call("POST", "/api/holdings", [FUND])).status).toBe(400);
  });

  it("edits a holding; unknown ids are 404 and bad ids 400", async () => {
    const h = await create();
    const r = await call("PUT", `/api/holdings/${h.id}`, { ...FUND, name: "Renamed", units: 3_000_000.5 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: "Renamed", units: 3_000_000.5 });
    expect((await call("PUT", "/api/holdings/9999", FUND)).status).toBe(404);
    expect((await call("PUT", "/api/holdings/abc", FUND)).status).toBe(400);
    expect((await call("PUT", `/api/holdings/${h.id}`, { ...FUND, units: -3 })).status).toBe(400);
    expect((await call("GET", "/api/holdings")).json.holdings[0].name).toBe("Renamed"); // failed edit changed nothing
  });
  it("deletes a holding, once", async () => {
    const h = await create();
    expect((await call("DELETE", `/api/holdings/${h.id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/holdings/${h.id}`)).status).toBe(404);
    expect((await call("DELETE", "/api/holdings/x")).status).toBe(400);
  });
  it("records create/update/price/delete in the audit log without any price-sensitive secrets", async () => {
    const h = await create();
    await call("PUT", `/api/holdings/${h.id}`, FUND);
    await call("POST", `/api/holdings/${h.id}/price`, { price: 28_000 });
    await call("DELETE", `/api/holdings/${h.id}`);
    const rows = db.prepare("SELECT decision FROM audit_log WHERE decision LIKE 'holding_%'").all() as { decision: string }[];
    expect(rows.map((r) => r.decision)).toEqual(expect.arrayContaining(["holding_created", "holding_updated", "holding_price_set", "holding_deleted"]));
  });
  it("hostile text is stored and returned as inert JSON data", async () => {
    const evil = "x'); DROP TABLE holdings;--<img src=x onerror=alert(1)>";
    const r = await call("POST", "/api/holdings", { ...FUND, name: evil, notes: evil });
    expect(r.status).toBe(201);
    expect((await call("GET", "/api/holdings")).json.holdings[0].name).toBe(evil);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='holdings'").get()).toBeTruthy();
  });
});

describe("manual NAV updates", () => {
  it("sets the NAV with a date (default today) and the summary reflects it immediately", async () => {
    const h = await create();
    const r = await call("POST", `/api/holdings/${h.id}/price`, { price: 30_000 });
    expect(r.json).toMatchObject({ manualPrice: 30_000, manualPriceAsOf: today() });
    const s = (await call("GET", "/api/investments/summary")).json;
    expect(s.holdings[0]).toMatchObject({ priceStatus: "fresh", priceKind: "manual", price: 30_000 });
    expect(s.holdings[0].marketValue).toBeCloseTo(6_000_000, 4); // 2,000,000 units x 30,000 / 10,000
  });
  it.each([
    ["a negative NAV", { price: -1 }],
    ["a non-number", { price: "30000" }],
    ["a future date", { price: 1, asOf: "2999-01-01" }],
    ["an impossible date", { price: 1, asOf: "2026-02-30" }],
    ["extra fields", { price: 1, units: 99 }],
  ])("rejects %s", async (_n, body) => {
    const h = await create();
    expect((await call("POST", `/api/holdings/${h.id}/price`, body)).status).toBe(400);
  });
  it("404s for unknown holdings and 400s for bad ids", async () => {
    expect((await call("POST", "/api/holdings/9999/price", { price: 1 })).status).toBe(404);
    expect((await call("POST", "/api/holdings/zz/price", { price: 1 })).status).toBe(400);
  });
});

describe("GET /api/investments/summary", () => {
  it("is empty and complete with no holdings", async () => {
    const r = await call("GET", "/api/investments/summary");
    expect(r.json.summary).toMatchObject({ marketValue: 0, totalCost: 0, unrealizedPct: null, complete: true, allocation: [] });
    expect(mockQuotes).not.toHaveBeenCalled(); // nothing to quote, no provider traffic
  });

  it("values the whole starting portfolio in JPY and never marks a missing price as fresh", async () => {
    await create({ manualPrice: 30_000, manualPriceAsOf: today() }); // cost 5,000,000 -> 6,000,000
    await create({ name: "Gold Fund", assetType: "commodity_fund", units: 1_000_000, avgPrice: 20_000 }); // no NAV yet
    const s = (await call("GET", "/api/investments/summary")).json;
    expect(s.baseCurrency).toBe("JPY");
    expect(s.summary).toMatchObject({ complete: false, missingCount: 1, pricedCount: 1, hasStale: false });
    expect(s.summary.marketValue).toBeCloseTo(6_000_000, 4);
    expect(s.summary.totalCost).toBeCloseTo(7_000_000, 4);
    expect(s.summary.unrealizedPnl).toBeCloseTo(1_000_000, 4);
    expect(s.summary.unrealizedPct).toBeCloseTo(20, 8);
    const gold = s.holdings.find((h: { name: string }) => h.name === "Gold Fund");
    expect(gold).toMatchObject({ priceStatus: "missing", price: null, marketValue: null, unrealizedPnl: null });
    expect(s.summary.warnings.join(" ")).toMatch(/no price/);
  });

  it("flags an old NAV as stale (still shown, never fresh)", async () => {
    const h = await create({ manualPrice: 30_000, manualPriceAsOf: "2026-01-05" });
    expect(h.manualPriceAsOf).toBe("2026-01-05");
    const s = (await call("GET", "/api/investments/summary")).json;
    expect(s.holdings[0]).toMatchObject({ priceStatus: "stale" });
    expect(s.summary).toMatchObject({ hasStale: true, staleCount: 1 });
  });

  describe("Bitcoin via a live BTC-JPY quote", () => {
    const btc = (over: Record<string, unknown> = {}) => create({ name: "Bitcoin", assetType: "crypto", symbol: "BTC-JPY", priceSource: "quote", priceUnit: 1, units: 0.5, avgPrice: 10_000_000, ...over });
    const holding0 = async () => (await call("GET", "/api/investments/summary")).json.holdings[0];

    it("uses a fresh live quote and asks the provider only for the configured symbol", async () => {
      await btc();
      mockQuotes.mockResolvedValue([q()]);
      const h = await holding0();
      expect(h).toMatchObject({ priceStatus: "fresh", priceKind: "quote", price: 12_000_000, marketValue: 6_000_000, unrealizedPnl: 1_000_000 });
      expect(mockQuotes).toHaveBeenCalledWith(["BTC-JPY"]);
    });
    it("asks once per distinct symbol however many holdings share it", async () => {
      await btc();
      await btc({ name: "Bitcoin (second account)" });
      mockQuotes.mockResolvedValue([q()]);
      await call("GET", "/api/investments/summary");
      expect(mockQuotes).toHaveBeenCalledTimes(1);
      expect(mockQuotes.mock.calls[0][0]).toEqual(["BTC-JPY"]);
    });
    it("REJECTS a USD quote (the BTC -> US ETF mis-resolution) and reports no price rather than a wrong one", async () => {
      await btc();
      mockQuotes.mockResolvedValue([q({ currency: "USD", price: 33.85 })]);
      const h = await holding0();
      expect(h).toMatchObject({ priceStatus: "missing", price: null, marketValue: null });
      expect(h.quoteIssue).toMatch(/USD, not JPY/);
    });
    it("provider failure: says so, and a manual price entered by the user still works", async () => {
      await btc();
      mockQuotes.mockRejectedValue(new Error("all providers down"));
      const none = (await call("GET", "/api/investments/summary")).json;
      expect(none.quoteError).toMatch(/unavailable/);
      expect(none.holdings[0].priceStatus).toBe("missing");
      await call("POST", `/api/holdings/${none.holdings[0].id}/price`, { price: 11_800_000 });
      const after = (await call("GET", "/api/investments/summary")).json;
      expect(after.holdings[0]).toMatchObject({ priceStatus: "fresh", priceKind: "manual", price: 11_800_000, marketValue: 5_900_000 });
    });
    it("a stale quote is not called fresh", async () => {
      await btc();
      mockQuotes.mockResolvedValue([q({ time: Math.floor(Date.now() / 1000) - 3600 })]);
      expect(await holding0()).toMatchObject({ priceStatus: "stale", priceKind: "quote" });
    });
    it("a last-known fallback served by the quote layer is flagged stale", async () => {
      await btc();
      mockQuotes.mockResolvedValue([q({ servedStale: true } as Partial<Quote>)]);
      expect(await holding0()).toMatchObject({ priceStatus: "stale" });
    });
    it("an unrelated quote in the response is ignored", async () => {
      await btc();
      mockQuotes.mockResolvedValue([q({ symbol: "ETH-JPY", price: 350_000 })]);
      expect((await holding0()).priceStatus).toBe("missing");
    });
    it("manual-source holdings never trigger provider traffic", async () => {
      await create({ manualPrice: 30_000 });
      await call("GET", "/api/investments/summary");
      expect(mockQuotes).not.toHaveBeenCalled();
    });
  });

  it("nothing in any response contains the API key", async () => {
    await create({ manualPrice: 1 });
    for (const p of ["/api/holdings", "/api/investments/summary"]) expect(JSON.stringify((await call("GET", p)).json)).not.toContain(KEY);
  });
});
