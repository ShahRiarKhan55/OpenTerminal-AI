import type { Observation } from "./types.js";

export type FreshnessPolicy = {
  /** Max age of a provider-declared real-time print. */
  maxAgeRealtimeSec: number;
  /** Max age of an exchange-delayed/indicative print (covers a ~15 min delay plus slack). */
  maxAgeDelayedSec: number;
  /** Tolerated clock skew for timestamps that appear to be in the future. */
  maxFutureSkewSec: number;
  /** Intraday alerts only fire while the primary session is open. */
  requireOpenMarket: boolean;
  /** Daily-close data is never valid for intraday alerts unless explicitly allowed. */
  allowEod: boolean;
};

export const DEFAULT_POLICY: FreshnessPolicy = {
  maxAgeRealtimeSec: 120,
  maxAgeDelayedSec: 1200,
  maxFutureSkewSec: 5,
  requireOpenMarket: true,
  allowEod: false,
};

export type FreshnessReason =
  | "ok"
  | "incomplete"
  | "served_stale"
  | "unknown_delay"
  | "eod_only"
  | "market_not_open"
  | "missing_timestamp"
  | "future_timestamp"
  | "stale";

export type FreshnessResult = {
  ok: boolean;
  reason: FreshnessReason;
  /** Age of the provider's own timestamp, if it supplied one. */
  ageSec: number | null;
};

function positiveFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function freshnessPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): FreshnessPolicy {
  return {
    ...DEFAULT_POLICY,
    maxAgeRealtimeSec: positiveFromEnv(env.MAX_QUOTE_AGE_SEC, DEFAULT_POLICY.maxAgeRealtimeSec),
    maxAgeDelayedSec: positiveFromEnv(env.MAX_DELAYED_AGE_SEC, DEFAULT_POLICY.maxAgeDelayedSec),
    requireOpenMarket: env.ALERT_ALLOW_EXTENDED_HOURS !== "true",
  };
}

/**
 * Decide whether an observation may be used to GENERATE AN ALERT. Pure and
 * clock-injected. Fails closed: anything we cannot positively prove fresh is
 * rejected, with a machine-readable reason for the audit log.
 *
 * Check order is deliberate: structural problems first, then "is the market
 * even open" (so a Sunday quote reports market_not_open rather than stale),
 * then timestamp presence and age.
 */
export function evaluateFreshness(
  obs: Observation,
  nowMs: number,
  policy: FreshnessPolicy = DEFAULT_POLICY
): FreshnessResult {
  const ageSec = obs.providerTimeMs === null ? null : (nowMs - obs.providerTimeMs) / 1000;
  const reject = (reason: FreshnessReason): FreshnessResult => ({ ok: false, reason, ageSec });

  if (!obs.symbol || obs.price === null || !Number.isFinite(obs.price) || obs.price <= 0) {
    return reject("incomplete");
  }
  if (obs.servedStale) return reject("served_stale");
  if (obs.delayClass === "unknown") return reject("unknown_delay");
  if (obs.delayClass === "eod") {
    return policy.allowEod ? { ok: true, reason: "ok", ageSec } : reject("eod_only");
  }
  if (policy.requireOpenMarket && obs.phase !== "open") return reject("market_not_open");
  if (obs.providerTimeMs === null || !Number.isFinite(obs.providerTimeMs)) return reject("missing_timestamp");
  if (ageSec! < -policy.maxFutureSkewSec) return reject("future_timestamp");

  const maxAge = obs.delayClass === "realtime" ? policy.maxAgeRealtimeSec : policy.maxAgeDelayedSec;
  if (ageSec! > maxAge) return reject("stale");
  // Also bound how long THIS server has been holding the value, so a cached
  // object that outlived its TTL can't pass on the strength of a fresh-looking
  // provider timestamp alone.
  if (obs.fetchedAtMs !== null && (nowMs - obs.fetchedAtMs) / 1000 > maxAge) return reject("stale");

  return { ok: true, reason: "ok", ageSec };
}
