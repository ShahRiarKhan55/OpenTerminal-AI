/**
 * How timely a provider's price is, as far as we can honestly claim.
 *  - realtime: the provider itself declares the print is real-time (still age-checked)
 *  - delayed:  exchange-delayed or indicative (the default for scraped public endpoints)
 *  - eod:      end-of-day / daily close only (FRED, Stooq daily)
 *  - unknown:  we cannot tell; never eligible for alerts
 */
export type DelayClass = "realtime" | "delayed" | "eod" | "unknown";

/** Normalized trading phase of the instrument's primary venue. */
export type MarketPhase = "open" | "pre" | "post" | "closed" | "unknown";

/** Provider-agnostic, timestamped view of one price, the unit alert logic will consume. */
export type Observation = {
  symbol: string;
  price: number | null;
  /** When the provider says the price was printed (epoch ms); null if it didn't say. */
  providerTimeMs: number | null;
  /** When this server obtained it (epoch ms); null if unknown. */
  fetchedAtMs: number | null;
  source: string;
  delayClass: DelayClass;
  phase: MarketPhase;
  /** True when the value is a last-known fallback served after a provider failure. */
  servedStale: boolean;
};
