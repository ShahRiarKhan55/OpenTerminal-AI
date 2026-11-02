import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "../providers/yahoo.js";

vi.mock("../providers/nasdaq.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn() }));
vi.mock("../providers/yahoo.js", async (orig) => ({
  ...(await orig<object>()),
  quotes: vi.fn(),
  quoteFromChart: vi.fn(),
}));
vi.mock("../providers/stooq.js", async (orig) => ({ ...(await orig<object>()), quote: vi.fn() }));
vi.mock("../providers/tradingview.js", async (orig) => ({
  ...(await orig<object>()),
  scanFundamentals: vi.fn().mockResolvedValue(new Map()),
}));

import * as nasdaq from "../providers/nasdaq.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";

const nasdaqQuote = vi.mocked(nasdaq.quote);
const yahooQuotes = vi.mocked(yahoo.quotes);
const yahooChart = vi.mocked(yahoo.quoteFromChart);
const stooqQuote = vi.mocked(stooq.quote);

let tmpDir: string;
let server: Server;
let base: string;
let getQuotes: (typeof import("./market.js"))["getQuotes"];
let db: (typeof import("../db.js"))["db"];

function mkQuote(symbol: string, over: Partial<Quote> = {}): Quote {
  return {
    symbol, name: symbol, price: 100, change: null, changePercent: null, open: null, high: null, low: null,
    previousClose: null, bid: null, ask: null, volume: null, avgVolume: null, marketCap: null, pe: 1, eps: null,
    dividendYield: null, week52High: null, week52Low: null, beta: null, sharesOutstanding: null, currency: "USD",
    exchange: "NASDAQ", marketState: "Market Open", time: Math.floor(Date.now() / 1000), source: "nasdaq",
    delayClass: "realtime", ...over,
  };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ot-quotes-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.API_KEY = "k";
  const { createApp } = await import("../app.js");
  ({ getQuotes } = await import("./market.js"));
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
  for (const m of [nasdaqQuote, yahooQuotes, yahooChart, stooqQuote]) m.mockReset();
  // Default: every provider is down, so each test opts in to what works.
  nasdaqQuote.mockRejectedValue(new Error("nasdaq down"));
  yahooQuotes.mockRejectedValue(new Error("yahoo down"));
  yahooChart.mockRejectedValue(new Error("yahoo chart down"));
  stooqQuote.mockRejectedValue(new Error("stooq down"));
});

afterEach(() => vi.useRealTimers());

describe("getQuotes provider fallback", () => {
  it("uses Nasdaq first and stamps fetchedAt", async () => {
    nasdaqQuote.mockResolvedValue(mkQuote("QA1"));
    const t0 = Date.now();
    const [q] = await getQuotes(["QA1"]);
    expect(q.source).toBe("nasdaq");
    expect(q.fetchedAt).toBeGreaterThanOrEqual(t0);
    expect(q.servedStale).toBeUndefined();
    expect(yahooQuotes).not.toHaveBeenCalled();
  });

  it("falls back to Yahoo when Nasdaq fails", async () => {
    yahooQuotes.mockResolvedValue([mkQuote("QB1", { source: "yahoo" })]);
    const [q] = await getQuotes(["QB1"]);
    expect(q.source).toBe("yahoo");
  });

  it("falls back to Yahoo chart, then Stooq", async () => {
    yahooChart.mockResolvedValue(mkQuote("QC1", { source: "yahoo-chart" }));
    expect((await getQuotes(["QC1"]))[0].source).toBe("yahoo-chart");

    yahooChart.mockRejectedValue(new Error("down"));
    stooqQuote.mockResolvedValue(mkQuote("QC2", { source: "stooq", time: null, delayClass: "delayed" }));
    const [q] = await getQuotes(["QC2"]);
    expect(q.source).toBe("stooq");
    expect(q.time).toBeNull();
  });

  it("serves a symbol that resolves and omits one that does not, in one batch", async () => {
    nasdaqQuote.mockImplementation(async (s: string) => {
      if (s === "QD1") return mkQuote("QD1");
      throw new Error("nope");
    });
    const out = await getQuotes(["QD1", "QD2"]);
    expect(out.map((q) => q.symbol)).toEqual(["QD1"]);
  });

  it("serves repeat requests from cache without calling providers again", async () => {
    nasdaqQuote.mockResolvedValue(mkQuote("QE1"));
    await getQuotes(["QE1"]);
    await getQuotes(["QE1"]);
    expect(nasdaqQuote).toHaveBeenCalledTimes(1);
  });

  it("returns the last-known value flagged servedStale when every provider fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    nasdaqQuote.mockResolvedValue(mkQuote("QF1"));
    const [first] = await getQuotes(["QF1"]);
    vi.setSystemTime(Date.now() + 5_000); // past the 1s quote TTL
    nasdaqQuote.mockRejectedValue(new Error("down"));
    const [again] = await getQuotes(["QF1"]);
    expect(again.price).toBe(100);
    expect(again.servedStale).toBe(true);
    expect(again.fetchedAt).toBe(first.fetchedAt); // still shows how old it really is
    expect(first.servedStale).toBeUndefined(); // cached original not mutated
  });

  it("records quote-path provider health so /api/status can report it", async () => {
    nasdaqQuote.mockResolvedValue(mkQuote("QL1"));
    await getQuotes(["QL1"]);
    nasdaqQuote.mockRejectedValue(new Error("boom"));
    yahooQuotes.mockRejectedValue(new Error("boom"));
    await getQuotes(["QL2"]);
    const status = await (await fetch(`${base}/api/status`)).json();
    const n = status.providers.find((p: { name: string }) => p.name === "nasdaq");
    expect(n.ok).toBeGreaterThanOrEqual(1);
    expect(n.failed).toBeGreaterThanOrEqual(1);
    expect(n.lastError).toBe("boom");
    expect(n.lastSuccessAgeSec).toBeGreaterThanOrEqual(0);
    expect(n.lastSuccessAgeSec).toBeLessThan(30);
  });

  it("returns nothing for an unknown symbol with no history", async () => {
    expect(await getQuotes(["QG1"])).toEqual([]);
  });
});

describe("GET /api/quotes", () => {
  it("400s with no symbols", async () => {
    expect((await fetch(`${base}/api/quotes`)).status).toBe(400);
  });

  it("502s when nothing can be served", async () => {
    expect((await fetch(`${base}/api/quotes?symbols=QH1`)).status).toBe(502);
  });

  it("adds an accepting freshness verdict for a fresh open-market print", async () => {
    nasdaqQuote.mockResolvedValue(mkQuote("QI1"));
    const body = await (await fetch(`${base}/api/quotes?symbols=QI1`)).json();
    expect(body[0].freshness).toMatchObject({ ok: true, reason: "ok" });
    expect(body[0].delayClass).toBe("realtime");
  });

  it("flags pre-market, timestamp-less and stale-fallback quotes as not alert-eligible", async () => {
    nasdaqQuote.mockImplementation(async (s: string) => {
      if (s === "QJ1") return mkQuote("QJ1", { marketState: "Pre-Market" });
      if (s === "QJ2") return mkQuote("QJ2", { time: null });
      throw new Error("down");
    });
    const body = await (await fetch(`${base}/api/quotes?symbols=QJ1,QJ2`)).json();
    const bySym = Object.fromEntries(body.map((q: Quote & { freshness: { reason: string } }) => [q.symbol, q.freshness.reason]));
    expect(bySym).toEqual({ QJ1: "market_not_open", QJ2: "missing_timestamp" });
  });

  it("reports served_stale through the route", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    nasdaqQuote.mockResolvedValue(mkQuote("QK1", { time: Math.floor(Date.now() / 1000) }));
    await fetch(`${base}/api/quotes?symbols=QK1`);
    vi.setSystemTime(Date.now() + 5_000);
    nasdaqQuote.mockRejectedValue(new Error("down"));
    const body = await (await fetch(`${base}/api/quotes?symbols=QK1`)).json();
    expect(body[0].servedStale).toBe(true);
    expect(body[0].freshness.reason).toBe("served_stale");
  });
});
