# Architecture

OpenTerminal AI is a local-first market terminal with a continuously running **paper-trading** monitor.
Nothing in it can place a real order (see [SAFETY.md](SAFETY.md)).

```
Browser (Next.js)                                    Telegram (outbound only)
   │  fetch /api/*                                           ▲
   ▼                                                         │
Next route handler  ──adds X-Api-Key (server-side only)──►  Express API ◄────── SQLite (WAL) ──────► Monitor worker
   web :3000                                                   :4000      watchlists · signals · alerts      (separate process)
                                                                          paper ledger · audit · reports       ├─ data poller (budgeted)
Public data providers (Nasdaq, Yahoo, Stooq, TradingView,                 settings · worker_state · ai_calls   ├─ freshness gate
FRED, Forex Factory, RSS) ◄─── shared cache + rate limiters ───┬──────────────────────────────────────────────┤  ├─ detectors + strategies
                                                               └── API (dashboard widgets)                    ├─ risk gate + sizing
                                                                                                              ├─ paper broker (ledger only)
Anthropic API ◄── event-triggered, hard daily budget ──────────────────────────────────────────────────────  ├─ alert / de-dupe / audit
                                                                                                              └─ Telegram outbox · reports
```

The **API** serves the dashboard; the **worker** does the monitoring. They never call each other: they
share one SQLite file (WAL, `busy_timeout`), and the worker's heartbeat row is how the dashboard knows it is alive.
If the worker is down the dashboard still works; it simply says so.

## One monitoring cycle (`server/src/worker/tick.ts`)

1. **Quotes** for the watchlist + open positions + pending signals + benchmarks, through the same cache and
   rate limiters the dashboard uses (`marketdata/quotes.ts`).
2. **Freshness gate** (`marketdata/freshness.ts`): each quote becomes an `Observation` (price, provider timestamp,
   delay class, session phase). A strict verdict decides alert/entry eligibility; a relaxed verdict (no
   session requirement) is used only to manage exits. Fail-closed: no timestamp, stale, last-known fallback,
   unknown delay, end-of-day-only or out-of-session all mean *no action*, with the reason in the audit log.
3. **Market conditions**: SPY/QQQ/IWM/VIX → risk-on / neutral / risk-off.
4. **Exits** for open paper positions (stop, target, +1R breakeven, flat-by, session end) and the daily-loss check.
5. **Pending entries**: re-evaluated on fresh data only.
6. **Detection** (fresh, in-session data only): event detectors (large moves, volume spikes, RSI extremes,
   near-52w-high) and two long-only strategies (`engine/strategies.ts`):
   - **ORB**: opening-range breakout on *closed* 5-minute bars, volume- and VWAP-confirmed.
   - **20-day breakout**: new 20-day high above the 50-day SMA on time-of-day-adjusted volume, ATR stop.
   Candidates are de-duplicated per strategy/symbol/session in SQLite.
7. **Risk gate + sizing** (`engine/risk.ts`): risk-per-trade sizing from the *fill* price, position-size and cash
   caps, max open positions, trades/day, daily loss limit, symbol cooldown after a stop, entry window,
   reward/risk, spread, liquidity, kill switch. All failing reasons are recorded.
8. **Paper broker** (`engine/paper.ts`): transactional, idempotent ledger. Fills slip *against* the trader.
9. **Alerts** (`notify/alerts.ts`): persistent de-duplication + cooldown + daily cap, every decision audited.
10. **AI** (`notify/ai.ts`): only for a freshly raised alert of sufficient importance, within a hard daily
    budget, minimum spacing and duplicate suppression. Failures never block the alert.
11. **Telegram** outbox with retry/backoff and per-day cap; **reports** (daily after 16:20 ET, weekly) with catch-up.
12. **Heartbeat** written last.

Each step is isolated: an exception is logged, audited and counted but never aborts the cycle.

## Data provenance and honesty

The free public endpoints are delayed or indicative. Every quote carries `delayClass`, the provider's timestamp and
the time this server fetched it; the UI and every alert state it (`delayed/indicative · 42s old · nasdaq`). Nasdaq's
chart endpoint is daily-only, so intraday strategies depend on Yahoo's 5-minute bars; when those are rate-limited or
stale the intraday strategies skip and say so. Nothing is interpolated or invented.

## Why deterministic detection + a small AI budget

Detection, risk and fills are plain TypeScript functions of their inputs: reproducible, unit-testable, free to run
every minute. A language model adds value in *explaining* a rare, already-detected event, not in deciding
whether one happened, so it is called per event under a hard budget rather than per quote.
`notify/ai.ts` defines an `AnalysisProvider` interface; Claude is the v1 implementation and a local model would be a
second implementation with no other code changes.

## Extending

- **Crypto**: providers (`binance`, `coingecko`) already exist for display. To monitor crypto, relax the symbol
  schema (`engine/store.ts`), add a 24/7 session model to `marketdata/freshness.ts` (`phase` is already per
  observation) and crypto strategies. Nothing in the data model is stocks-specific.
- **A paid/real-time data source**: implement `DataSource` (`worker/runtime.ts`). The worker, risk and tests are
  unaffected.
- **A local model**: implement `AnalysisProvider`.

## Layout

| Path | What |
|---|---|
| `server/src/marketdata/` | Observation model, freshness gate, quote aggregation, ET time helpers |
| `server/src/engine/` | Indicators, strategies, risk/sizing, entry/exit rules, paper ledger, persistence (all pure or SQLite-only) |
| `server/src/notify/` | Alerts (de-dupe/cap), Telegram, AI budget + provider |
| `server/src/worker/` | The monitor: tick, loop, reports, live data source, entrypoint |
| `server/src/routes/` | Market-data routes (keyless) and the engine API (`trading.ts`, API key required) |
| `server/src/migrations.ts` | Versioned, append-only schema migrations |
| `web/components/widgets/` | Alerts & Signals, Paper Trading, Monitor (plus the original widgets) |
