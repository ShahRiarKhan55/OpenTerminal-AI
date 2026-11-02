import { evaluateFreshness, type FreshnessPolicy, type FreshnessReason } from "./freshness.js";
import type { DelayClass, Observation } from "./types.js";

/**
 * Bounded record of the latest Observation per symbol, so /api/status can
 * report data quality without exposing which symbols the user is watching.
 */
const MAX_TRACKED = 500;
const latest = new Map<string, Observation>();

export function recordObservation(obs: Observation): void {
  latest.delete(obs.symbol);
  latest.set(obs.symbol, obs);
  while (latest.size > MAX_TRACKED) {
    const oldest = latest.keys().next().value;
    if (oldest === undefined) break;
    latest.delete(oldest);
  }
}

export type DataQualitySummary = {
  tracked: number;
  alertEligible: number;
  byDelayClass: Record<DelayClass, number>;
  rejectedByReason: Partial<Record<FreshnessReason, number>>;
  oldestAgeSec: number | null;
  newestAgeSec: number | null;
};

export function summarize(nowMs: number, policy: FreshnessPolicy): DataQualitySummary {
  const byDelayClass: Record<DelayClass, number> = { realtime: 0, delayed: 0, eod: 0, unknown: 0 };
  const rejectedByReason: Partial<Record<FreshnessReason, number>> = {};
  let alertEligible = 0;
  let oldest: number | null = null;
  let newest: number | null = null;

  for (const obs of latest.values()) {
    byDelayClass[obs.delayClass]++;
    const r = evaluateFreshness(obs, nowMs, policy);
    if (r.ok) alertEligible++;
    else rejectedByReason[r.reason] = (rejectedByReason[r.reason] ?? 0) + 1;
    if (r.ageSec !== null) {
      oldest = oldest === null ? r.ageSec : Math.max(oldest, r.ageSec);
      newest = newest === null ? r.ageSec : Math.min(newest, r.ageSec);
    }
  }
  const round = (n: number | null) => (n === null ? null : Math.round(n));
  return {
    tracked: latest.size,
    alertEligible,
    byDelayClass,
    rejectedByReason,
    oldestAgeSec: round(oldest),
    newestAgeSec: round(newest),
  };
}

/** Test helper. */
export function _resetLedger(): void {
  latest.clear();
}
