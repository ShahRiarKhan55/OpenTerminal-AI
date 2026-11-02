import type { Quote } from "../providers/yahoo.js";
import type { MarketPhase, Observation } from "./types.js";

/** Map the many provider spellings of "what session is it" onto one vocabulary. */
export function normalizeMarketPhase(state: string | null | undefined): MarketPhase {
  if (!state) return "unknown";
  const s = state.toLowerCase();
  if (s.includes("pre")) return "pre"; // "Pre-Market", "PRE", "PREPRE"
  if (s.includes("post") || s.includes("after")) return "post"; // "After-Hours", "POST", "POSTPOST"
  if (s.includes("closed") || s.includes("close")) return "closed";
  if (s.includes("open") || s.includes("regular")) return "open"; // "Market Open", "REGULAR", "Open"
  return "unknown";
}

// Provider timestamps are epoch seconds by convention here, but guard against a
// provider (or future parser) handing back milliseconds.
function toMs(t: number): number {
  return t > 1e11 ? t : t * 1000;
}

export function toObservation(q: Quote): Observation {
  return {
    symbol: q.symbol,
    price: q.price,
    providerTimeMs: q.time !== null && q.time !== undefined && Number.isFinite(q.time) ? toMs(q.time) : null,
    fetchedAtMs: q.fetchedAt ?? null,
    source: q.source,
    delayClass: q.delayClass,
    phase: normalizeMarketPhase(q.marketState),
    servedStale: q.servedStale === true,
  };
}
