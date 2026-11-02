import { getQuotes } from "../marketdata/quotes.js";
import * as econcalendar from "../providers/econcalendar.js";
import * as news from "../providers/news.js";
import * as nasdaq from "../providers/nasdaq.js";
import { tracked } from "../providers/registry.js";
import * as stooq from "../providers/stooq.js";
import * as yahoo from "../providers/yahoo.js";
import type { DataSource } from "./runtime.js";

/**
 * Production data source: the same free public providers the dashboard uses,
 * sharing its cache and rate limiters. Intraday 5-minute bars exist only on
 * Yahoo (Nasdaq's chart endpoint is daily-only); when Yahoo is rate-limited the
 * intraday strategies skip, rather than guess.
 */
export function createLiveSource(): DataSource {
  return {
    quotes: (symbols) => getQuotes(symbols),

    intradayBars: (symbol) => tracked("yahoo", () => yahoo.history(symbol, "1d", "5m")),

    async dailyBars(symbol) {
      const attempts: Array<[string, () => Promise<yahoo.Candle[]>]> = [
        ["nasdaq", () => nasdaq.history(symbol, "6M")],
        ["yahoo", () => yahoo.history(symbol, "6mo", "1d")],
        ["stooq", () => stooq.history(symbol)],
      ];
      let last: unknown = new Error("no providers");
      for (const [name, fn] of attempts) {
        try {
          const bars = await tracked(name, fn);
          if (bars.length > 0) return bars;
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },

    economicEvents: () => tracked("forexfactory", () => econcalendar.weeklyEvents()),

    async headlines(symbol) {
      const items = await tracked("news", () => news.symbolNews(symbol));
      return items.map((i) => ({ title: i.title, publisher: i.publisher, publishedAt: i.publishedAt }));
    },
  };
}
