/**
 * Personal-investment valuation. PURE: no I/O, no clock reads (callers pass `nowMs`), so every rule is
 * unit-testable. The rules this module exists to guarantee:
 *
 *  - market value = units x price / priceUnit; cost basis = units x avgPrice / priceUnit. Japanese mutual
 *    funds quote their NAV (基準価額) per 10,000 units, so `priceUnit` is explicit instead of assumed.
 *  - A missing price is never replaced by cost, and a stale price is never labelled fresh.
 *  - Amounts in different currencies are never added together. Anything not in the base currency is
 *    excluded from base-currency totals unless an explicit, dated FX rate is supplied.
 */

export const BASE_CURRENCY = "JPY";
/** Currencies the API accepts for holdings. Widening this (plus supplying FX rates) is how USD etc. arrive later. */
export const SUPPORTED_CURRENCIES = ["JPY"] as const;
export const ASSET_TYPES = ["mutual_fund", "commodity_fund", "etf", "stock", "crypto", "other"] as const;
export const PRICE_UNITS = [1, 10_000] as const;

export type AssetType = (typeof ASSET_TYPES)[number];
export type PriceUnit = (typeof PRICE_UNITS)[number];
export type PriceSource = "manual" | "quote";

export type Holding = {
  id: number;
  name: string;
  assetType: AssetType;
  symbol: string | null;
  currency: string;
  units: number;
  avgPrice: number;
  priceUnit: PriceUnit;
  priceSource: PriceSource;
  manualPrice: number | null;
  /** The date the manual price/NAV refers to (YYYY-MM-DD, Japan time). */
  manualPriceAsOf: string | null;
  /** When the manual price was typed in (epoch ms). */
  manualPriceUpdatedAt: number | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

/** A raw provider reading. The caller must NOT pre-judge freshness: this module does. */
export type QuoteReading = {
  symbol: string;
  price: number | null;
  currency: string | null;
  /** Provider's own timestamp (epoch ms); null when it did not supply one. */
  timeMs: number | null;
  source: string;
  /** True when this is a last-known fallback served after every provider failed. */
  servedStale: boolean;
};

export type PricePolicy = {
  /** A live quote older than this is stale. */
  quoteMaxAgeMs: number;
  /** A manual price older than this (per asset type) is stale. */
  manualMaxAgeMs: Record<AssetType, number>;
  /** Tolerated clock skew for timestamps that appear to be in the future. */
  maxFutureSkewMs: number;
};

const HOUR = 3_600_000;
export const DEFAULT_POLICY: PricePolicy = {
  quoteMaxAgeMs: 15 * 60_000,
  manualMaxAgeMs: {
    // Funds publish a NAV each business day; 4 days covers a normal weekend (and one extra holiday) but not a missed week.
    mutual_fund: 96 * HOUR,
    commodity_fund: 96 * HOUR,
    etf: 96 * HOUR,
    stock: 96 * HOUR,
    other: 96 * HOUR,
    // A hand-typed crypto price is only meaningful for about a day.
    crypto: 24 * HOUR,
  },
  maxFutureSkewMs: 5_000,
};

export type PriceStatus = "fresh" | "stale" | "missing";
export type PriceKind = "quote" | "manual";

export type HoldingValuation = {
  id: number;
  name: string;
  assetType: AssetType;
  symbol: string | null;
  currency: string;
  units: number;
  avgPrice: number;
  priceUnit: PriceUnit;
  /** Price per `priceUnit` units, or null when there is no usable price. */
  price: number | null;
  priceStatus: PriceStatus;
  priceKind: PriceKind | null;
  /** Time the price refers to (provider time, or the NAV date/entry time for manual prices). */
  priceTimeMs: number | null;
  /** Human-readable origin, e.g. "yahoo" or "manual NAV 2026-11-02". */
  priceLabel: string;
  /** Why a live quote was not used (symbol/currency mismatch, stale, unavailable...), if relevant. */
  quoteIssue: string | null;
  costBasis: number;
  marketValue: number | null;
  unrealizedPnl: number | null;
  /** Percent of cost basis; null when cost is zero (undefined, never 0 or Infinity). */
  unrealizedPct: number | null;
  invalid: boolean;
};

const finiteNonNeg = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** Start of a Japan-time calendar day (JST is UTC+9 all year, no DST). */
export function jstDayStartMs(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00+09:00`);
  return Number.isFinite(ms) ? ms : null;
}

export function jstDateKey(ms: number): string {
  return new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
}

/**
 * The instant a manual price should be considered to date from. A NAV for an earlier day dates from that
 * day's start; a price entered for TODAY dates from the moment it was typed (so a crypto price entered
 * 2 hours ago is 2 hours old, not "up to 24 hours").
 */
export function manualPriceTimeMs(h: Pick<Holding, "manualPrice" | "manualPriceAsOf" | "manualPriceUpdatedAt">): number | null {
  if (h.manualPrice === null) return null;
  const dayStart = h.manualPriceAsOf ? jstDayStartMs(h.manualPriceAsOf) : null;
  if (h.manualPriceUpdatedAt !== null && h.manualPriceAsOf && jstDateKey(h.manualPriceUpdatedAt) === h.manualPriceAsOf) return h.manualPriceUpdatedAt;
  return dayStart ?? h.manualPriceUpdatedAt;
}

type Candidate = { kind: PriceKind; price: number; timeMs: number | null; fresh: boolean; label: string };

function isFresh(timeMs: number | null, nowMs: number, maxAgeMs: number, skewMs: number): boolean {
  if (timeMs === null || !Number.isFinite(timeMs)) return false; // cannot prove freshness without a timestamp
  const age = nowMs - timeMs;
  return age >= -skewMs && age <= maxAgeMs;
}

/** Value one holding. Never throws; bad data yields `invalid: true` with null amounts. */
export function valueHolding(h: Holding, quote: QuoteReading | null, nowMs: number, policy: PricePolicy = DEFAULT_POLICY): HoldingValuation {
  const base = {
    id: h.id, name: h.name, assetType: h.assetType, symbol: h.symbol, currency: h.currency, units: h.units, avgPrice: h.avgPrice, priceUnit: h.priceUnit,
  };
  const valid = finiteNonNeg(h.units) && finiteNonNeg(h.avgPrice) && (h.priceUnit === 1 || h.priceUnit === 10_000);
  if (!valid) {
    return { ...base, price: null, priceStatus: "missing", priceKind: null, priceTimeMs: null, priceLabel: "invalid holding data", quoteIssue: null, costBasis: 0, marketValue: null, unrealizedPnl: null, unrealizedPct: null, invalid: true };
  }
  const costBasis = (h.units * h.avgPrice) / h.priceUnit;

  const candidates: Candidate[] = [];
  let quoteIssue: string | null = null;

  if (h.priceSource === "quote") {
    if (!h.symbol) quoteIssue = "no symbol configured for live quotes";
    else if (!quote) quoteIssue = "live quote unavailable";
    else if (quote.symbol.trim().toUpperCase() !== h.symbol.trim().toUpperCase()) quoteIssue = `quote was for ${quote.symbol}, not ${h.symbol}`;
    else if (!(typeof quote.price === "number" && Number.isFinite(quote.price) && quote.price > 0)) quoteIssue = "live quote has no valid price";
    else if (!quote.currency) quoteIssue = "live quote did not state its currency, so it cannot be verified";
    else if (quote.currency.toUpperCase() !== h.currency.toUpperCase()) quoteIssue = `live quote is in ${quote.currency}, not ${h.currency} (ignored)`;
    else {
      const fresh = !quote.servedStale && isFresh(quote.timeMs, nowMs, policy.quoteMaxAgeMs, policy.maxFutureSkewMs);
      candidates.push({ kind: "quote", price: quote.price, timeMs: quote.timeMs, fresh, label: quote.source });
      if (!fresh) quoteIssue = quote.servedStale ? "live quote is a last-known fallback (provider unavailable)" : quote.timeMs === null ? "live quote has no timestamp" : "live quote is too old";
    }
  }

  if (h.manualPrice !== null && finiteNonNeg(h.manualPrice)) {
    const t = manualPriceTimeMs(h);
    candidates.push({
      kind: "manual",
      price: h.manualPrice,
      timeMs: t,
      fresh: isFresh(t, nowMs, policy.manualMaxAgeMs[h.assetType], policy.maxFutureSkewMs),
      label: `manual${h.assetType === "crypto" ? " price" : " NAV"}${h.manualPriceAsOf ? ` ${h.manualPriceAsOf}` : ""}`,
    });
  }

  // Prefer the most recent FRESH candidate (quotes win ties); otherwise fall back to the most recent STALE one, flagged.
  const byRecency = (a: Candidate, b: Candidate) => (b.timeMs ?? -Infinity) - (a.timeMs ?? -Infinity);
  const fresh = candidates.filter((c) => c.fresh).sort(byRecency);
  const stale = candidates.filter((c) => !c.fresh).sort(byRecency);
  const chosen = fresh[0] ?? stale[0] ?? null;

  if (!chosen) {
    return { ...base, price: null, priceStatus: "missing", priceKind: null, priceTimeMs: null, priceLabel: "no price", quoteIssue, costBasis, marketValue: null, unrealizedPnl: null, unrealizedPct: null, invalid: false };
  }
  const marketValue = (h.units * chosen.price) / h.priceUnit;
  const unrealizedPnl = marketValue - costBasis;
  return {
    ...base,
    price: chosen.price,
    priceStatus: chosen.fresh ? "fresh" : "stale",
    priceKind: chosen.kind,
    priceTimeMs: chosen.timeMs,
    priceLabel: chosen.label,
    // A used manual price after a failed quote is worth saying out loud; so is any rejected quote.
    quoteIssue: chosen.kind === "manual" && h.priceSource === "quote" && !quoteIssue ? "used the manual price instead of a live quote" : quoteIssue,
    costBasis,
    marketValue,
    unrealizedPnl,
    unrealizedPct: costBasis > 0 ? (unrealizedPnl / costBasis) * 100 : null,
    invalid: false,
  };
}

export type FxRate = { /** base-currency units per 1 unit of the foreign currency */ rate: number; asOfMs: number };

export type AllocationEntry = { id: number; name: string; value: number; pct: number | null };

export type PortfolioSummary = {
  baseCurrency: string;
  /** Sum of market values of PRICED holdings in the base currency. */
  marketValue: number;
  /** Total invested: cost basis of every included holding (priced or not). */
  totalCost: number;
  /** Cost basis of the priced holdings only: the like-for-like denominator for P/L. */
  pricedCost: number;
  unrealizedPnl: number;
  /** Percent of pricedCost; null when pricedCost is zero. */
  unrealizedPct: number | null;
  allocation: AllocationEntry[];
  /** True only when every included holding has a price. */
  complete: boolean;
  hasStale: boolean;
  pricedCount: number;
  missingCount: number;
  staleCount: number;
  /** Holdings left out of the base-currency totals, with the reason. */
  excluded: { id: number; name: string; currency: string; reason: string }[];
  warnings: string[];
};

const MAX_FX_AGE_MS = 24 * HOUR;

/**
 * Aggregate valuations into base-currency totals. Holdings in another currency are EXCLUDED (and listed) unless a
 * fresh, explicit FX rate for that currency is supplied; nothing is ever summed across currencies implicitly.
 */
export function summarize(vals: HoldingValuation[], opts: { base?: string; fxRates?: Record<string, FxRate>; nowMs?: number } = {}): PortfolioSummary {
  const base = (opts.base ?? BASE_CURRENCY).toUpperCase();
  const excluded: PortfolioSummary["excluded"] = [];
  const rows: { v: HoldingValuation; mv: number | null; cost: number }[] = [];

  for (const v of vals) {
    if (v.invalid) {
      excluded.push({ id: v.id, name: v.name, currency: v.currency, reason: "invalid holding data" });
      continue;
    }
    const ccy = v.currency.toUpperCase();
    if (ccy === base) {
      rows.push({ v, mv: v.marketValue, cost: v.costBasis });
      continue;
    }
    const fx = opts.fxRates?.[ccy];
    if (!fx) {
      excluded.push({ id: v.id, name: v.name, currency: ccy, reason: `${ccy} holding: no FX rate to ${base}, so it is not included in ${base} totals` });
    } else if (!(Number.isFinite(fx.rate) && fx.rate > 0) || opts.nowMs === undefined || opts.nowMs - fx.asOfMs > MAX_FX_AGE_MS || fx.asOfMs - opts.nowMs > 5_000) {
      excluded.push({ id: v.id, name: v.name, currency: ccy, reason: `${ccy}/${base} FX rate is missing, invalid or stale, so the holding is not included in ${base} totals` });
    } else {
      rows.push({ v, mv: v.marketValue === null ? null : v.marketValue * fx.rate, cost: v.costBasis * fx.rate });
    }
  }

  let marketValue = 0;
  let pricedCost = 0;
  let totalCost = 0;
  let missingCount = 0;
  let staleCount = 0;
  let pricedCount = 0;
  for (const r of rows) {
    totalCost += r.cost;
    if (r.mv === null) {
      missingCount++;
      continue;
    }
    pricedCount++;
    marketValue += r.mv;
    pricedCost += r.cost;
    if (r.v.priceStatus === "stale") staleCount++;
  }

  const allocation: AllocationEntry[] = rows
    .filter((r) => r.mv !== null)
    .map((r) => ({ id: r.v.id, name: r.v.name, value: r.mv as number, pct: marketValue > 0 ? ((r.mv as number) / marketValue) * 100 : null }))
    .sort((a, b) => b.value - a.value);

  const unrealizedPnl = marketValue - pricedCost;
  const warnings: string[] = [];
  if (missingCount > 0) warnings.push(`${missingCount} holding${missingCount > 1 ? "s have" : " has"} no price and ${missingCount > 1 ? "are" : "is"} left out of market value and profit/loss. Totals are incomplete.`);
  if (staleCount > 0) warnings.push(`${staleCount} price${staleCount > 1 ? "s are" : " is"} stale. Update ${staleCount > 1 ? "them" : "it"} before relying on the totals.`);
  if (excluded.length > 0) warnings.push(`${excluded.length} holding${excluded.length > 1 ? "s are" : " is"} not included in ${base} totals (other currency or invalid data).`);

  return {
    baseCurrency: base,
    marketValue,
    totalCost,
    pricedCost,
    unrealizedPnl,
    unrealizedPct: pricedCost > 0 ? (unrealizedPnl / pricedCost) * 100 : null,
    allocation,
    complete: missingCount === 0,
    hasStale: staleCount > 0,
    pricedCount,
    missingCount,
    staleCount,
    excluded,
    warnings,
  };
}
