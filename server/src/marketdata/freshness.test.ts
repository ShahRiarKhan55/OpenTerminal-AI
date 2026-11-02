import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, evaluateFreshness, freshnessPolicyFromEnv } from "./freshness.js";
import { _resetLedger, recordObservation, summarize } from "./ledger.js";
import { normalizeMarketPhase, toObservation } from "./observation.js";
import type { Observation } from "./types.js";
import type { Quote } from "../providers/yahoo.js";

const NOW = Date.UTC(2026, 6, 15, 15, 0, 0); // a Wednesday, mid-session

function obs(over: Partial<Observation> = {}): Observation {
  return {
    symbol: "AAPL",
    price: 200,
    providerTimeMs: NOW - 10_000,
    fetchedAtMs: NOW - 1_000,
    source: "nasdaq",
    delayClass: "realtime",
    phase: "open",
    servedStale: false,
    ...over,
  };
}

describe("evaluateFreshness", () => {
  it("accepts a fresh, open-market, real-time print", () => {
    expect(evaluateFreshness(obs(), NOW)).toEqual({ ok: true, reason: "ok", ageSec: 10 });
  });

  describe("incomplete data", () => {
    it.each([null, 0, -5, NaN, Infinity * 0])("rejects price %s", (price) => {
      expect(evaluateFreshness(obs({ price: price as number | null }), NOW).reason).toBe("incomplete");
    });
    it("rejects an empty symbol", () => {
      expect(evaluateFreshness(obs({ symbol: "" }), NOW).reason).toBe("incomplete");
    });
  });

  it("rejects a last-known fallback served after provider failure", () => {
    expect(evaluateFreshness(obs({ servedStale: true }), NOW).reason).toBe("served_stale");
  });

  it("rejects data whose timeliness is unknown", () => {
    expect(evaluateFreshness(obs({ delayClass: "unknown" }), NOW).reason).toBe("unknown_delay");
  });

  it("rejects end-of-day data unless explicitly allowed", () => {
    const eod = obs({ delayClass: "eod" });
    expect(evaluateFreshness(eod, NOW).reason).toBe("eod_only");
    expect(evaluateFreshness(eod, NOW, { ...DEFAULT_POLICY, allowEod: true }).ok).toBe(true);
  });

  describe("market phase", () => {
    it.each(["pre", "post", "closed", "unknown"] as const)("rejects phase %s", (phase) => {
      expect(evaluateFreshness(obs({ phase }), NOW).reason).toBe("market_not_open");
    });
    it("reports market_not_open (not stale) for an old weekend print", () => {
      const r = evaluateFreshness(obs({ phase: "closed", providerTimeMs: NOW - 3 * 86_400_000 }), NOW);
      expect(r.reason).toBe("market_not_open");
    });
    it("allows extended hours when the policy permits", () => {
      const policy = { ...DEFAULT_POLICY, requireOpenMarket: false };
      expect(evaluateFreshness(obs({ phase: "pre" }), NOW, policy).ok).toBe(true);
    });
  });

  describe("timestamps", () => {
    it("rejects a missing provider timestamp (cannot prove freshness)", () => {
      const r = evaluateFreshness(obs({ providerTimeMs: null }), NOW);
      expect(r).toEqual({ ok: false, reason: "missing_timestamp", ageSec: null });
    });
    it("rejects a timestamp from the future beyond skew tolerance", () => {
      expect(evaluateFreshness(obs({ providerTimeMs: NOW + 60_000 }), NOW).reason).toBe("future_timestamp");
    });
    it("tolerates small clock skew", () => {
      expect(evaluateFreshness(obs({ providerTimeMs: NOW + 3_000 }), NOW).ok).toBe(true);
    });
    it("rejects a non-finite timestamp", () => {
      expect(evaluateFreshness(obs({ providerTimeMs: NaN }), NOW).reason).toBe("missing_timestamp");
    });
  });

  describe("age limits by delay class", () => {
    it("real-time: ok at the limit, stale one second past it", () => {
      const at = obs({ providerTimeMs: NOW - 120_000, fetchedAtMs: NOW });
      expect(evaluateFreshness(at, NOW).ok).toBe(true);
      const over = obs({ providerTimeMs: NOW - 121_000, fetchedAtMs: NOW });
      expect(evaluateFreshness(over, NOW).reason).toBe("stale");
    });
    it("delayed: a 15 minute old print is acceptable, 21 minutes is not", () => {
      const ok = obs({ delayClass: "delayed", providerTimeMs: NOW - 900_000, fetchedAtMs: NOW });
      expect(evaluateFreshness(ok, NOW).ok).toBe(true);
      const bad = obs({ delayClass: "delayed", providerTimeMs: NOW - 1_260_000, fetchedAtMs: NOW });
      expect(evaluateFreshness(bad, NOW).reason).toBe("stale");
    });
    it("rejects a fresh-looking print held by the server for too long", () => {
      const held = obs({ providerTimeMs: NOW - 5_000, fetchedAtMs: NOW - 300_000 });
      expect(evaluateFreshness(held, NOW).reason).toBe("stale");
    });
  });
});

describe("freshnessPolicyFromEnv", () => {
  it("uses defaults when unset", () => {
    expect(freshnessPolicyFromEnv({})).toEqual(DEFAULT_POLICY);
  });
  it("reads overrides", () => {
    const p = freshnessPolicyFromEnv({ MAX_QUOTE_AGE_SEC: "30", MAX_DELAYED_AGE_SEC: "600", ALERT_ALLOW_EXTENDED_HOURS: "true" });
    expect(p).toMatchObject({ maxAgeRealtimeSec: 30, maxAgeDelayedSec: 600, requireOpenMarket: false });
  });
  it.each(["abc", "-1", "0", "", "Infinity"])("ignores invalid value %j and keeps the default", (v) => {
    expect(freshnessPolicyFromEnv({ MAX_QUOTE_AGE_SEC: v }).maxAgeRealtimeSec).toBe(DEFAULT_POLICY.maxAgeRealtimeSec);
  });
  it("never allows extended hours by accident", () => {
    expect(freshnessPolicyFromEnv({ ALERT_ALLOW_EXTENDED_HOURS: "1" }).requireOpenMarket).toBe(true);
  });
});

describe("normalizeMarketPhase", () => {
  it.each([
    ["Pre-Market", "pre"],
    ["PRE", "pre"],
    ["PREPRE", "pre"],
    ["After-Hours", "post"],
    ["POST", "post"],
    ["Market Closed", "closed"],
    ["CLOSED", "closed"],
    ["Market Open", "open"],
    ["REGULAR", "open"],
    ["Open", "open"],
    ["something else", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
  ])("%j -> %s", (input, expected) => {
    expect(normalizeMarketPhase(input as string | null)).toBe(expected);
  });
});

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: "MSFT", name: null, price: 400, change: null, changePercent: null, open: null, high: null, low: null,
    previousClose: null, bid: null, ask: null, volume: null, avgVolume: null, marketCap: null, pe: null, eps: null,
    dividendYield: null, week52High: null, week52Low: null, beta: null, sharesOutstanding: null, currency: "USD",
    exchange: "NASDAQ", marketState: "Market Open", time: NOW / 1000 - 5, source: "nasdaq", delayClass: "realtime",
    fetchedAt: NOW - 500,
    ...over,
  };
}

describe("toObservation", () => {
  it("converts seconds to ms and normalizes the phase", () => {
    const o = toObservation(quote());
    expect(o.providerTimeMs).toBe(NOW - 5_000);
    expect(o.phase).toBe("open");
    expect(o.servedStale).toBe(false);
  });
  it("accepts a millisecond timestamp without multiplying it again", () => {
    expect(toObservation(quote({ time: NOW - 5_000 })).providerTimeMs).toBe(NOW - 5_000);
  });
  it("keeps a missing timestamp missing", () => {
    expect(toObservation(quote({ time: null })).providerTimeMs).toBeNull();
  });
  it("carries the served-stale flag", () => {
    expect(toObservation(quote({ servedStale: true })).servedStale).toBe(true);
  });
});

describe("ledger summary", () => {
  beforeEach(() => _resetLedger());

  it("counts eligible and rejected observations without exposing symbols", () => {
    recordObservation(obs({ symbol: "GOOD" }));
    recordObservation(obs({ symbol: "OLD", providerTimeMs: NOW - 600_000 }));
    recordObservation(obs({ symbol: "NOTS", providerTimeMs: null }));
    recordObservation(obs({ symbol: "VIX", delayClass: "eod" }));
    const s = summarize(NOW, DEFAULT_POLICY);
    expect(s.tracked).toBe(4);
    expect(s.alertEligible).toBe(1);
    expect(s.rejectedByReason).toEqual({ stale: 1, missing_timestamp: 1, eod_only: 1 });
    expect(s.byDelayClass).toEqual({ realtime: 3, delayed: 0, eod: 1, unknown: 0 });
    expect(s.oldestAgeSec).toBe(600);
    expect(JSON.stringify(s)).not.toMatch(/GOOD|OLD|NOTS/);
  });

  it("keeps only the latest observation per symbol", () => {
    recordObservation(obs({ providerTimeMs: NOW - 600_000 }));
    recordObservation(obs());
    expect(summarize(NOW, DEFAULT_POLICY).alertEligible).toBe(1);
  });

  it("is bounded", () => {
    for (let i = 0; i < 700; i++) recordObservation(obs({ symbol: `S${i}` }));
    expect(summarize(NOW, DEFAULT_POLICY).tracked).toBe(500);
  });
});
