import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../providers/nasdaq.js", async (orig) => ({ ...(await orig<object>()), history: vi.fn() }));
vi.mock("../providers/yahoo.js", async (orig) => ({ ...(await orig<object>()), history: vi.fn() }));
vi.mock("../providers/stooq.js", async (orig) => ({ ...(await orig<object>()), history: vi.fn() }));
vi.mock("../providers/news.js", async (orig) => ({ ...(await orig<object>()), symbolNews: vi.fn() }));

import * as nasdaq from "../providers/nasdaq.js";
import * as news from "../providers/news.js";
import { allStats } from "../providers/registry.js";
import * as stooq from "../providers/stooq.js";
import * as yahoo from "../providers/yahoo.js";
import { createLiveSource } from "./liveSource.js";

const nHist = vi.mocked(nasdaq.history);
const yHist = vi.mocked(yahoo.history);
const sHist = vi.mocked(stooq.history);
const bar = (t: number) => ({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 });
const src = createLiveSource();

beforeEach(() => {
  for (const m of [nHist, yHist, sHist, vi.mocked(news.symbolNews)]) m.mockReset();
  nHist.mockRejectedValue(new Error("nasdaq down"));
  yHist.mockRejectedValue(new Error("yahoo down"));
  sHist.mockRejectedValue(new Error("stooq down"));
});

describe("live data source: daily bars fallback chain", () => {
  it("prefers Nasdaq", async () => {
    nHist.mockResolvedValue([bar(1)]);
    expect(await src.dailyBars("AAA")).toEqual([bar(1)]);
    expect(yHist).not.toHaveBeenCalled();
  });
  it("falls back to Yahoo, then Stooq", async () => {
    yHist.mockResolvedValue([bar(2)]);
    expect(await src.dailyBars("BBB")).toEqual([bar(2)]);
    yHist.mockRejectedValue(new Error("down"));
    sHist.mockResolvedValue([bar(3)]);
    expect(await src.dailyBars("CCC")).toEqual([bar(3)]);
  });
  it("treats an EMPTY answer as a failure and keeps trying (an empty history is not a result)", async () => {
    nHist.mockResolvedValue([]);
    yHist.mockResolvedValue([bar(4)]);
    expect(await src.dailyBars("DDD")).toEqual([bar(4)]);
  });
  it("rejects when every provider fails, rather than returning made-up bars", async () => {
    await expect(src.dailyBars("EEE")).rejects.toThrow();
    nHist.mockResolvedValue([]);
    yHist.mockResolvedValue([]);
    sHist.mockResolvedValue([]);
    await expect(src.dailyBars("FFF")).rejects.toThrow();
  });
  it("records provider health so the dashboard can show it", async () => {
    nHist.mockRejectedValue(new Error("boom-visible"));
    yHist.mockResolvedValue([bar(5)]);
    await src.dailyBars("GGG");
    const stats = Object.fromEntries(allStats().map((s) => [s.name, s]));
    expect(stats.nasdaq.failed).toBeGreaterThan(0);
    expect(stats.nasdaq.lastError).toBe("boom-visible");
    expect(stats.yahoo.ok).toBeGreaterThan(0);
  });
});

describe("live data source: intraday and news", () => {
  it("requests today's 5-minute bars from Yahoo (Nasdaq's chart is daily-only)", async () => {
    yHist.mockResolvedValue([bar(6)]);
    await src.intradayBars("HHH");
    expect(yHist).toHaveBeenCalledWith("HHH", "1d", "5m");
    expect(nHist).not.toHaveBeenCalled();
  });
  it("lets an intraday failure propagate so the worker can skip ORB (never fabricate bars)", async () => {
    await expect(src.intradayBars("III")).rejects.toThrow("yahoo down");
  });
  it("maps headlines to the worker's shape", async () => {
    vi.mocked(news.symbolNews).mockResolvedValue([{ title: "T", link: "https://x", publisher: "P", publishedAt: "2026-07-15T10:00:00Z", symbol: "JJJ" }]);
    expect(await src.headlines("JJJ")).toEqual([{ title: "T", publisher: "P", publishedAt: "2026-07-15T10:00:00Z" }]);
  });
});
