// Types, parsing and formatting for the personal investment dashboard (server: server/src/routes/investments.ts).
// All money here is in the portfolio base currency (JPY); the server is the source of truth for every calculation.

export const ASSET_TYPES = ["mutual_fund", "commodity_fund", "etf", "stock", "crypto", "other"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];
export type PriceUnit = 1 | 10000;
export type PriceSource = "manual" | "quote";
export type PriceStatus = "fresh" | "stale" | "missing";

export type HoldingDto = {
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
  manualPriceAsOf: string | null;
  manualPriceUpdatedAt: number | null;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ValuationDto = {
  id: number;
  name: string;
  assetType: AssetType;
  symbol: string | null;
  currency: string;
  units: number;
  avgPrice: number;
  priceUnit: PriceUnit;
  price: number | null;
  priceStatus: PriceStatus;
  priceKind: "quote" | "manual" | null;
  priceTimeMs: number | null;
  priceLabel: string;
  quoteIssue: string | null;
  costBasis: number;
  marketValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPct: number | null;
  invalid: boolean;
  holding: HoldingDto;
};

export type SummaryDto = {
  baseCurrency: string;
  marketValue: number;
  totalCost: number;
  pricedCost: number;
  unrealizedPnl: number;
  unrealizedPct: number | null;
  allocation: { id: number; name: string; value: number; pct: number | null }[];
  complete: boolean;
  hasStale: boolean;
  pricedCount: number;
  missingCount: number;
  staleCount: number;
  excluded: { id: number; name: string; currency: string; reason: string }[];
  warnings: string[];
};

export type InvestmentsResponse = { asOf: number; baseCurrency: string; summary: SummaryDto; holdings: ValuationDto[]; quoteError: string | null };

export const ASSET_TYPE_LABEL: Record<AssetType, string> = {
  mutual_fund: "Mutual fund (投資信託)",
  commodity_fund: "Gold / commodity fund",
  etf: "ETF",
  stock: "Stock",
  crypto: "Cryptocurrency",
  other: "Other",
};

/** Sensible default pricing basis: Japanese fund NAVs are quoted per 10,000 units, everything else per 1 unit. */
export function defaultPriceUnit(t: AssetType): PriceUnit {
  return t === "mutual_fund" || t === "commodity_fund" ? 10000 : 1;
}

export type FormState = {
  name: string;
  assetType: AssetType;
  symbol: string;
  units: string;
  avgPrice: string;
  priceUnit: PriceUnit;
  priceSource: PriceSource;
  manualPrice: string;
  manualPriceAsOf: string;
  notes: string;
};

export const EMPTY_FORM: FormState = { name: "", assetType: "mutual_fund", symbol: "", units: "", avgPrice: "", priceUnit: 10000, priceSource: "manual", manualPrice: "", manualPriceAsOf: "", notes: "" };

/** One-click starting points. They fill in what is known; the numbers (units, cost, NAV) are always yours to enter. */
export const PRESETS: { id: string; label: string; form: Partial<FormState> }[] = [
  { id: "orukan", label: "eMAXIS Slim All Country (オルカン)", form: { name: "eMAXIS Slim All Country (オルカン)", assetType: "mutual_fund", priceUnit: 10000, priceSource: "manual", symbol: "" } },
  { id: "gold", label: "Gold Fund", form: { name: "Gold Fund", assetType: "commodity_fund", priceUnit: 10000, priceSource: "manual", symbol: "" } },
  { id: "btc", label: "Bitcoin (BTC-JPY)", form: { name: "Bitcoin", assetType: "crypto", priceUnit: 1, priceSource: "quote", symbol: "BTC-JPY" } },
];

export function formFromHolding(h: HoldingDto): FormState {
  return {
    name: h.name, assetType: h.assetType, symbol: h.symbol ?? "", units: String(h.units), avgPrice: String(h.avgPrice), priceUnit: h.priceUnit,
    priceSource: h.priceSource, manualPrice: h.manualPrice === null ? "" : String(h.manualPrice), manualPriceAsOf: h.manualPriceAsOf ?? "", notes: h.notes ?? "",
  };
}

// ---------------------------------------------------------------- number input

export type Parsed = { ok: true; value: number | null } | { ok: false; error: string };

/**
 * Parse what a person types into a number field. Accepts thousands separators, a leading yen sign, surrounding
 * spaces, and full-width characters (１２３,４５６.７), which is how Japanese keyboards often enter digits.
 * Empty input is "no value" (null). Anything else that is not a plain decimal is an error, never a guess.
 */
export function parseDecimal(raw: string): Parsed {
  const s = raw.normalize("NFKC").replace(/[¥￥円,\s]/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(s) && !/^\.\d+$/.test(s)) return { ok: false, error: "enter a plain number, such as 1234.56" };
  const n = Number(s);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "that number is too large" };
}

export type PayloadResult = { ok: true; body: Record<string, unknown> } | { ok: false; errors: Record<string, string> };

/** Turn the form into the API body, with friendly per-field errors. The server re-validates everything. */
export function buildHoldingPayload(f: FormState): PayloadResult {
  const errors: Record<string, string> = {};
  const name = f.name.trim();
  if (!name) errors.name = "give the holding a name";
  const units = parseDecimal(f.units);
  const avg = parseDecimal(f.avgPrice);
  const price = parseDecimal(f.manualPrice);
  if (!units.ok) errors.units = units.error;
  else if (units.value === null) errors.units = "enter the number of units held (0 is allowed)";
  if (!avg.ok) errors.avgPrice = avg.error;
  else if (avg.value === null) errors.avgPrice = "enter your average purchase price (0 is allowed)";
  if (!price.ok) errors.manualPrice = price.error;
  const symbol = f.symbol.trim();
  if (f.priceSource === "quote" && !symbol) errors.symbol = "a symbol such as BTC-JPY is needed for live quotes";
  if (f.manualPriceAsOf && !/^\d{4}-\d{2}-\d{2}$/.test(f.manualPriceAsOf)) errors.manualPriceAsOf = "use the date format YYYY-MM-DD";
  if (f.manualPriceAsOf && price.ok && price.value === null) errors.manualPrice = "enter the price/NAV for that date, or clear the date";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    body: {
      name,
      assetType: f.assetType,
      symbol: symbol || null,
      currency: "JPY",
      units: (units as { value: number }).value,
      avgPrice: (avg as { value: number }).value,
      priceUnit: f.priceUnit,
      priceSource: f.priceSource,
      manualPrice: (price as { value: number | null }).value,
      manualPriceAsOf: (price as { value: number | null }).value === null ? null : f.manualPriceAsOf || null,
      notes: f.notes.trim() || null,
    },
  };
}

// ---------------------------------------------------------------- formatting

const nf = (max: number, min = 0) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

/** Whole yen with a ¥ sign; negative amounts as -¥. Unknown values are an em dash, never "¥0". */
export function formatYen(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}¥${nf(0).format(Math.abs(r))}`;
}

/** "+¥1,234" / "-¥1,234" (explicit sign for profit/loss). */
export function formatSignedYen(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const r = Math.round(n);
  return `${r < 0 ? "-" : "+"}¥${nf(0).format(Math.abs(r))}`;
}

export function formatPercent(n: number | null | undefined, signed = false, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const abs = nf(digits, digits).format(Math.abs(n));
  const zero = Number(abs.replace(/,/g, "")) === 0;
  return `${signed ? (n < 0 && !zero ? "-" : zero ? "" : "+") : n < 0 && !zero ? "-" : ""}${abs}%`;
}

/** Units with up to 8 decimals (satoshi precision) and no trailing zeros. */
export function formatUnits(n: number): string {
  return Number.isFinite(n) ? nf(8).format(n) : "—";
}

/** A price in yen, keeping decimals where they matter (small prices) and none for large ones. */
export function formatPrice(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `¥${(Math.abs(n) >= 1000 ? nf(0) : nf(2, 2)).format(n)}`;
}

export function priceUnitLabel(u: PriceUnit): string {
  return u === 10000 ? "per 10,000 units" : "per unit";
}

/** Japan-time wall clock, e.g. "2026-11-03 12:00 JST". */
export function formatJst(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} JST`;
}

export function jstToday(now = Date.now()): string {
  return new Date(now + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function formatAge(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown time";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

export type StatusBadge = { text: string; tone: "up" | "amber" | "down" | "dim"; hint: string };

export function priceBadge(v: Pick<ValuationDto, "priceStatus" | "priceKind" | "quoteIssue">): StatusBadge {
  if (v.priceStatus === "missing") return { text: "NO PRICE", tone: "down", hint: v.quoteIssue ?? "Enter a price or NAV; this holding is excluded from totals until you do." };
  if (v.priceStatus === "stale") return { text: "STALE", tone: "amber", hint: v.quoteIssue ?? "This price is old. Update it before relying on the value." };
  return v.priceKind === "quote"
    ? { text: "LIVE", tone: "up", hint: "Fresh market quote." }
    : { text: "MANUAL", tone: "up", hint: v.quoteIssue ?? "Manually entered, and recent enough to be considered current." };
}

export function toneClass(tone: StatusBadge["tone"]): string {
  return tone === "up" ? "up" : tone === "down" ? "down" : tone === "amber" ? "amber" : "dim";
}
