import { createHash } from "node:crypto";
import { audit, pruneOldData } from "../audit.js";
import { IMPORTANCE_RANK } from "../config.js";
import { classifyRegime, detectMarketEvents, detectUpcomingEconomicEvents, type MarketConditions } from "../engine/marketEvents.js";
import { listOpenPositions } from "../engine/paper.js";
import { getWorkerState, loadRiskConfig, monitoredSymbols, pendingSignals, setWorkerState } from "../engine/store.js";
import { detectBreakout20, detectOrb } from "../engine/strategies.js";
import type { Bar, DetectResult } from "../engine/types.js";
import { evaluateFreshness } from "../marketdata/freshness.js";
import { toObservation } from "../marketdata/observation.js";
import { etClock } from "../marketdata/time.js";
import { enrichWithAi, flushTelegram, raiseAlert } from "../notify/alerts.js";
import { aiUsageToday } from "../notify/ai.js";
import { maybeCreateReports } from "./reports.js";
import { BENCHMARKS, gate, type Runtime, type WorkerDeps } from "./runtime.js";
import { checkDailyLossLimit, handleCandidate, manageOpenPositions, processPendingSignals, takeAiSlot, type Obs, type TickCtx } from "./trading.js";

const MAX_CANDLE_FETCHES_PER_TICK = 10;
const MAX_AI_PER_TICK = 2;
const NEWS_SYMBOLS_PER_REFRESH = 5;
const NEWS_MAX_AGE_MS = 6 * 3_600_000;
const NEWS_COOLDOWN_MS = 7 * 86_400_000;
const ECON_REFRESH_MS = 30 * 60_000;

export type TickSummary = {
  at: number;
  phase: "open" | "other";
  symbols: number;
  quotes: number;
  eligible: number;
  rejected: number;
  signals: number;
  alerts: number;
  errors: string[];
  ms: number;
};

/** Run one step; a failure is recorded and logged but never aborts the rest of the tick. */
async function step(name: string, deps: WorkerDeps, rt: Runtime, summary: TickSummary, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    summary.errors.push(`${name}: ${msg}`);
    rt.errorCount++;
    rt.lastError = `${name}: ${msg}`;
    deps.log.error("tick step failed", { step: name, err: msg });
    audit(deps.db, { kind: "system", decision: "step_failed", reason: name, detail: { error: msg.slice(0, 300) } }, deps.now());
  }
}

/** Is the cached entry usable (present and not older than `maxAgeMs`)? */
const usable = <T>(e: { value: T; fetchedAt: number } | undefined, now: number, maxAgeMs: number) => (e && now - e.fetchedAt <= maxAgeMs ? e.value : null);

export async function runTick(deps: WorkerDeps, rt: Runtime): Promise<TickSummary> {
  const t0 = Date.now();
  const { db, cfg, source, log } = deps;
  const now = deps.now();
  const clock = etClock(now);
  const summary: TickSummary = { at: now, phase: "other", symbols: 0, quotes: 0, eligible: 0, rejected: 0, signals: 0, alerts: 0, errors: [], ms: 0 };
  rt.tickCount++;

  const { config: risk, fellBack } = loadRiskConfig(db);
  if (fellBack && gate(rt, "risk-fallback", 3_600_000, now)) {
    audit(db, { kind: "config", decision: "risk_config_invalid_using_defaults" }, now);
    log.warn("stored risk configuration invalid; using safe defaults");
  }

  const ctx: TickCtx = { deps, rt, now, risk, aiBudgetThisTick: { left: MAX_AI_PER_TICK }, regime: "unknown" };
  const { symbols: watch, truncated } = monitoredSymbols(db, cfg.maxSymbols);
  if (truncated && gate(rt, "watch-truncated", 3_600_000, now)) {
    log.warn("watchlists exceed MONITOR_MAX_SYMBOLS; extra symbols are not monitored", { cap: cfg.maxSymbols });
    audit(db, { kind: "system", decision: "watchlist_truncated", detail: { cap: cfg.maxSymbols } }, now);
  }
  const open = listOpenPositions(db);
  const pending = pendingSignals(db);
  const needed = [...new Set([...watch, ...open.map((p) => p.symbol), ...pending.map((s) => s.symbol), ...BENCHMARKS])];
  summary.symbols = watch.length;
  // Memory stays proportional to what is being watched: drop cached candles for symbols that left.
  const stillNeeded = new Set(needed);
  for (const cache of [rt.intraday, rt.daily]) for (const sym of cache.keys()) if (!stillNeeded.has(sym)) cache.delete(sym);

  // ---- 1. quotes -> observations -> freshness verdicts ----
  const obs = new Map<string, Obs>();
  await step("quotes", deps, rt, summary, async () => {
    let quotes;
    try {
      quotes = await source.quotes(needed);
      if (quotes.length === 0) throw new Error("no quotes returned");
      rt.quoteFailures = 0;
    } catch (err) {
      rt.quoteFailures++;
      if (rt.quoteFailures >= 3) {
        raiseAlert(
          { db, nowMs: now, cfg },
          {
            type: "provider_outage",
            symbol: null,
            importance: "high",
            dedupeKey: `outage:${Math.floor(now / 3_600_000)}`,
            cooldownMs: 3_600_000,
            title: "Market data unavailable",
            body: `${rt.quoteFailures} consecutive quote refreshes failed. Alerts and paper exits are paused until data recovers.`,
          }
        );
      }
      throw err;
    }
    summary.quotes = quotes.length;
    for (const q of quotes) {
      const o = toObservation(q);
      const strict = evaluateFreshness(o, now, cfg.freshness);
      const relaxed = evaluateFreshness(o, now, { ...cfg.freshness, requireOpenMarket: false });
      obs.set(q.symbol, { quote: q, obs: o, strict, relaxed });
      if (strict.ok) summary.eligible++;
      else if (watch.includes(q.symbol) && strict.reason !== "market_not_open") {
        summary.rejected++;
        // One audit line per symbol+reason per 30 min, so a long outage doesn't flood the log.
        if (gate(rt, `reject:${q.symbol}:${strict.reason}`, 30 * 60_000, now)) {
          audit(db, { kind: "data", symbol: q.symbol, decision: "rejected", reason: strict.reason, detail: { source: q.source, delayClass: q.delayClass, ageSec: strict.ageSec } }, now);
        }
      }
    }
    // Remember that the market was open today (drives daily-report creation; holidays stay quiet).
    // "The market is open" means the EQUITY market. ^VIX (and other index/futures-hours products)
    // legitimately report an open session while stocks are still in pre-market, so it must not count.
    const equityOpen = [...obs.entries()].some(([sym, o]) => sym !== "^VIX" && o.obs.phase === "open" && o.relaxed.ok);
    if (equityOpen) {
      summary.phase = "open";
      const dates = getWorkerState<string[]>(db, "open_dates")?.value ?? [];
      if (!dates.includes(clock.dateKey)) setWorkerState(db, "open_dates", [...dates, clock.dateKey].slice(-21), now);
    }
  });

  // ---- 2. market conditions ----
  await step("conditions", deps, rt, summary, () => {
    const idx = ["SPY", "QQQ", "IWM"].map((s) => {
      const o = obs.get(s);
      return {
        symbol: s,
        price: o?.quote.price ?? null,
        changePercent: o?.quote.changePercent ?? null,
        ageSec: o?.relaxed.ageSec != null ? Math.round(o.relaxed.ageSec) : null,
        delayClass: o?.obs.delayClass ?? "unknown",
        eligible: o?.strict.ok ?? false,
      };
    });
    const vix = obs.get("^VIX")?.quote.price ?? null;
    const regime = classifyRegime(idx[0].changePercent, vix);
    ctx.regime = regime;
    const note = regime === "unknown" ? "Market data unavailable." : `SPY ${idx[0].changePercent?.toFixed(2) ?? "n/a"}%${vix !== null ? `, VIX ${vix.toFixed(1)}` : ""}.`;
    const c: MarketConditions = { asOf: now, regime, indices: idx, vix, note };
    setWorkerState(db, "market_conditions", c, now);
  });

  // ---- 3. manage what we already hold, then pending entries ----
  await step("exits", deps, rt, summary, () => {
    manageOpenPositions(ctx, obs);
    checkDailyLossLimit(ctx);
  });
  await step("pending-signals", deps, rt, summary, async () => {
    await processPendingSignals(ctx, obs);
  });

  // ---- 4. detection (only on data that passes the strict freshness gate) ----
  let fetches = 0;
  const bars = async (kind: "intraday" | "daily", symbol: string): Promise<Bar[] | null> => {
    const cache = kind === "intraday" ? rt.intraday : rt.daily;
    const refreshMs = (kind === "intraday" ? cfg.candleRefreshSeconds : cfg.dailyRefreshSeconds) * 1000;
    const hit = cache.get(symbol);
    if (hit && now - hit.fetchedAt < refreshMs) return hit.value;
    if (fetches >= MAX_CANDLE_FETCHES_PER_TICK) return usable(hit, now, refreshMs * 3);
    fetches++;
    try {
      const value = kind === "intraday" ? await source.intradayBars(symbol) : await source.dailyBars(symbol);
      cache.set(symbol, { value, fetchedAt: now });
      return value;
    } catch (err) {
      if (gate(rt, `bars:${kind}:${symbol}`, 15 * 60_000, now)) log.warn("candle fetch failed", { kind, symbol, err: err instanceof Error ? err.message : String(err) });
      return usable(hit, now, refreshMs * 3);
    }
  };

  await step("detect", deps, rt, summary, async () => {
    for (const symbol of watch) {
      const o = obs.get(symbol);
      if (!o || !o.strict.ok || o.quote.price === null) continue;
      const q = o.quote;
      const price = q.price!;

      const daily = await bars("daily", symbol);
      for (const e of detectMarketEvents({ symbol, price, changePercent: q.changePercent, volume: q.volume, avgVolume: q.avgVolume, week52High: q.week52High }, daily, now)) {
        const r = raiseAlert(
          { db, nowMs: now, cfg },
          { type: e.type, symbol, importance: e.importance, dedupeKey: e.dedupeKey, cooldownMs: e.cooldownMs, title: e.title, body: e.body, dataLabel: `${o.obs.delayClass === "realtime" ? "provider-reported real-time" : "delayed/indicative"} · ${Math.round(o.strict.ageSec ?? 0)}s old · ${o.obs.source}`, payload: e.facts }
        );
        if ("alertId" in r && IMPORTANCE_RANK[e.importance] >= IMPORTANCE_RANK.high && takeAiSlot(ctx, r.alertId, e.importance)) {
          await enrichWithAi({ db, nowMs: now, cfg, provider: deps.ai, log }, r.alertId, { kind: e.type, symbol, facts: { ...e.facts, regime: ctx.regime } }, e.importance);
        }
      }

      const results: DetectResult[] = [];
      if (daily) results.push(detectBreakout20({ symbol, daily, price, volumeToday: q.volume, nowMs: now }));
      const intraday = await bars("intraday", symbol);
      if (intraday && intraday.length) {
        const lastEnd = Math.max(...intraday.map((b) => b.time)) * 1000 + 300_000;
        if (now - lastEnd > cfg.maxCandleLagSec * 1000) {
          if (gate(rt, `stale-bars:${symbol}`, 30 * 60_000, now)) audit(db, { kind: "data", symbol, decision: "rejected", reason: "stale_candles", detail: { lagSec: Math.round((now - lastEnd) / 1000) } }, now);
        } else results.push(detectOrb({ symbol, bars: intraday, nowMs: now }));
      }
      for (const r of results) {
        if (!r.ok) continue;
        summary.signals++;
        await handleCandidate(ctx, r.signal, o);
      }
    }
  });

  // ---- 5. calendar + news (low frequency) ----
  await step("calendar", deps, rt, summary, async () => {
    if (!clock.isWeekday) return;
    if (!rt.econ || now - rt.econ.fetchedAt > ECON_REFRESH_MS) {
      try {
        rt.econ = { value: await source.economicEvents(), fetchedAt: now };
      } catch (err) {
        if (gate(rt, "econ-fail", 3_600_000, now)) log.warn("economic calendar unavailable", { err: err instanceof Error ? err.message : String(err) });
      }
    }
    if (!rt.econ) return;
    for (const e of detectUpcomingEconomicEvents(rt.econ.value, now)) {
      raiseAlert({ db, nowMs: now, cfg }, { type: e.type, symbol: null, importance: e.importance, dedupeKey: e.dedupeKey, cooldownMs: e.cooldownMs, title: e.title, body: e.body, payload: e.facts });
    }
  });

  await step("news", deps, rt, summary, async () => {
    if (!cfg.newsEnabled || watch.length === 0 || now - rt.lastNewsAt < cfg.newsRefreshSeconds * 1000) return;
    rt.lastNewsAt = now;
    // Rotate through the watchlist a few symbols at a time to respect provider limits.
    for (let i = 0; i < Math.min(NEWS_SYMBOLS_PER_REFRESH, watch.length); i++) {
      const symbol = watch[(rt.newsCursor + i) % watch.length];
      let items;
      try {
        items = await source.headlines(symbol);
      } catch {
        continue;
      }
      for (const h of items.slice(0, 5)) {
        const published = h.publishedAt ? Date.parse(h.publishedAt) : NaN;
        if (!Number.isFinite(published) || now - published > NEWS_MAX_AGE_MS) continue; // unknown or old: ignore
        const hash = createHash("sha256").update(`${symbol}|${h.title.toLowerCase()}`).digest("hex").slice(0, 16);
        raiseAlert(
          { db, nowMs: now, cfg },
          { type: "news", symbol, importance: "low", dedupeKey: `news:${symbol}:${hash}`, cooldownMs: NEWS_COOLDOWN_MS, title: `${symbol}: ${h.title.slice(0, 140)}`, body: `${h.publisher}${h.publishedAt ? `, ${h.publishedAt}` : ""}. Headline only; not verified.` }
        );
      }
    }
    rt.newsCursor = (rt.newsCursor + NEWS_SYMBOLS_PER_REFRESH) % Math.max(1, watch.length);
  });

  // ---- 6. reports + maintenance ----
  await step("reports", deps, rt, summary, () => maybeCreateReports(deps, rt));
  await step("maintenance", deps, rt, summary, () => {
    if (rt.lastMaintenanceDate === clock.dateKey) return;
    rt.lastMaintenanceDate = clock.dateKey;
    const pruned = pruneOldData(db, cfg.retentionDays, now);
    audit(db, { kind: "system", decision: "maintenance", detail: pruned }, now);
    db.pragma("wal_checkpoint(PASSIVE)");
  });

  // ---- 7. deliver notifications ----
  await step("telegram", deps, rt, summary, async () => {
    if (!deps.telegram) return;
    await flushTelegram({ db, nowMs: now, target: deps.telegram.target, cfg, fetchImpl: deps.telegram.fetchImpl, sleep: deps.sleep, log });
  });

  summary.alerts = (db.prepare("SELECT COUNT(*) AS c FROM alerts WHERE created_at = ?").get(now) as { c: number }).c;
  summary.ms = Date.now() - t0;

  // ---- 8. heartbeat (written last: its age tells operators whether ticks complete) ----
  try {
    setWorkerState(
      db,
      "heartbeat",
      {
        pid: process.pid,
        startedAt: rt.startedAt,
        tickAt: now,
        tickMs: summary.ms,
        tickCount: rt.tickCount,
        errorCount: rt.errorCount,
        lastError: rt.lastError,
        quoteFailures: rt.quoteFailures,
        symbols: summary.symbols,
        eligible: summary.eligible,
        phase: summary.phase,
        pollSeconds: cfg.pollSeconds,
        tradingMode: cfg.tradingMode,
        telegram: Boolean(deps.telegram),
        ai: Boolean(deps.ai),
        aiUsage: aiUsageToday(db, now, cfg.ai.dailyLimit),
      },
      now
    );
  } catch (err) {
    log.error("heartbeat write failed", { err: err instanceof Error ? err.message : String(err) });
  }
  return summary;
}
