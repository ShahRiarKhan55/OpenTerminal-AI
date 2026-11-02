import { cacheGet, cacheStore, staleGet } from "../cache.js";
import { tracked } from "../providers/registry.js";
import * as yahoo from "../providers/yahoo.js";
import * as stooq from "../providers/stooq.js";
import * as nasdaq from "../providers/nasdaq.js";
import * as fred from "../providers/fred.js";
import * as tradingview from "../providers/tradingview.js";
import * as binance from "../providers/binance.js";
import { toObservation } from "./observation.js";
import { recordObservation } from "./ledger.js";

/** Per-symbol quote cache lifetime; every widget and the worker share it. */
const QUOTE_TTL = 1_000;

// ---- VIX: served from FRED (daily close), since it's an index rather than a
// tradable stock/ETF — Nasdaq's stock API doesn't carry it, and routing it
// through Yahoo would make it depend on Yahoo's flaky rate limits for no reason.

export function isVix(symbol: string): boolean {
  return symbol.toUpperCase() === "^VIX" || symbol.toUpperCase() === "VIX";
}

async function vixQuote(): Promise<yahoo.Quote> {
  const points = await fred.series("VIXCLS", 5);
  if (points.length === 0) throw new Error("fred: no VIX data");
  const last = points[points.length - 1];
  const prev = points.length > 1 ? points[points.length - 2] : null;
  const price = last.value;
  const previousClose = prev?.value ?? null;
  const change = previousClose !== null ? price - previousClose : null;
  const changePercent = previousClose ? (change! / previousClose) * 100 : null;
  return {
    symbol: "^VIX",
    name: "CBOE Volatility Index",
    price,
    change,
    changePercent,
    open: null,
    high: null,
    low: null,
    previousClose,
    bid: null,
    ask: null,
    volume: null,
    avgVolume: null,
    marketCap: null,
    pe: null,
    eps: null,
    dividendYield: null,
    week52High: null,
    week52Low: null,
    beta: null,
    sharesOutstanding: null,
    currency: "USD",
    exchange: "CBOE",
    marketState: null,
    time: Math.floor(new Date(last.date + "T00:00:00Z").getTime() / 1000),
    source: "fred",
    delayClass: "eod",
  };
}

/**
 * Resolve quotes for a symbol list, reusing a per-symbol cache across every
 * caller (single quote widget, watchlist, screener, heatmap all share hits).
 * Nasdaq's public quote API is primary (no key, generous limits); Yahoo and
 * Stooq are fallbacks. A symbol that fails everywhere still falls back to
 * its last-known value instead of failing the whole batch.
 *
 * Fan-out bound: the /quotes route caps `symbols` at 150, so a single call
 * here does at most ~150 crypto lookups (only for recognized crypto symbols,
 * mutually exclusive with the stages below) + up to 300 Nasdaq calls (2 per
 * miss) + 1 batched Yahoo call + up to FALLBACK_PER_SYMBOL_CAP per-symbol
 * Yahoo chart calls + up to FALLBACK_PER_SYMBOL_CAP Stooq calls + 1 batched
 * TradingView call. Repetition beyond that is bounded by marketRouter's
 * per-IP rate limit (see index.ts).
 */
const FALLBACK_PER_SYMBOL_CAP = 20;
export async function getQuotes(symbols: string[]): Promise<yahoo.Quote[]> {
  const fresh = new Map<string, yahoo.Quote>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const hit = cacheGet<yahoo.Quote>(`quote:${sym}`);
    if (hit) fresh.set(sym, hit);
    else missing.push(sym);
  }
  if (missing.length === 0) return symbols.map((s) => fresh.get(s)!).filter(Boolean);

  const fetched = new Map<string, yahoo.Quote>();
  let remaining = missing;

  const cryptoSymbols = remaining.filter((s) => binance.CRYPTO_SYMBOLS.has(s));
  if (cryptoSymbols.length > 0) {
    const results = await Promise.allSettled(cryptoSymbols.map((s) => tracked("binance", () => binance.quote(s))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(cryptoSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const vixSymbols = remaining.filter((s) => isVix(s));
  if (vixSymbols.length > 0) {
    const results = await Promise.allSettled(vixSymbols.map(() => tracked("fred", () => vixQuote())));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(vixSymbols[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  const nasdaqResults = await Promise.allSettled(remaining.map((s) => tracked("nasdaq", () => nasdaq.quote(s))));
  nasdaqResults.forEach((r, i) => {
    if (r.status === "fulfilled") fetched.set(remaining[i], r.value);
  });
  remaining = remaining.filter((s) => !fetched.has(s));

  if (remaining.length > 0) {
    try {
      const rows = await tracked("yahoo", () => yahoo.quotes(remaining));
      for (const q of rows) fetched.set(q.symbol, q);
      remaining = remaining.filter((s) => !fetched.has(s));
    } catch {
      // fall through to chart-based per-symbol fetch below
    }
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => tracked("yahoo-chart", () => yahoo.quoteFromChart(s))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
    remaining = remaining.filter((s) => !fetched.has(s));
  }

  if (remaining.length > 0) {
    const batch = remaining.slice(0, FALLBACK_PER_SYMBOL_CAP);
    const results = await Promise.allSettled(batch.map((s) => tracked("stooq", () => stooq.quote(s))));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") fetched.set(batch[i], r.value);
    });
  }

  // Fill gaps Nasdaq's quote endpoints don't cover (open, P/E, EPS, dividend
  // yield, beta, shares outstanding) from TradingView's public scanner API,
  // in one batched request for every quote that resolved an exchange.
  const needsFundamentals = [...fetched.values()].filter((q) => q.exchange && q.pe === null);
  if (needsFundamentals.length > 0) {
    try {
      const fundamentals = await tradingview.scanFundamentals(
        needsFundamentals.map((q) => ({ symbol: q.symbol, exchange: q.exchange }))
      );
      for (const q of needsFundamentals) {
        const f = fundamentals.get(q.symbol);
        if (!f) continue;
        q.open = q.open ?? f.open;
        q.pe = q.pe ?? f.pe;
        q.eps = q.eps ?? f.eps;
        q.dividendYield = q.dividendYield ?? f.dividendYield;
        q.beta = q.beta ?? f.beta;
        q.sharesOutstanding = q.sharesOutstanding ?? f.sharesOutstanding;
      }
    } catch {
      // best-effort enrichment only — never fails the quote request
    }
  }

  // Stamp when WE got it: lets freshness checks bound how long a cached object
  // has been held, independent of the provider's own (possibly missing) timestamp.
  const fetchedAt = Date.now();
  for (const [sym, q] of fetched) {
    q.fetchedAt = fetchedAt;
    cacheStore(`quote:${sym}`, q, QUOTE_TTL);
  }

  const out: yahoo.Quote[] = [];
  for (const sym of symbols) {
    const live = fresh.get(sym) ?? fetched.get(sym);
    if (live) {
      out.push(live);
      continue;
    }
    // Every provider failed: serve the last-known value, but say so explicitly
    // (on a copy, so the cached original is not mutated).
    const stale = staleGet<yahoo.Quote>(`quote:${sym}`);
    if (stale) out.push({ ...stale, servedStale: true });
  }
  for (const q of out) recordObservation(toObservation(q));
  return out;
}
