# Safety model

## What this is, and is not

A **paper-trading** research tool. It reads free public market data (delayed or indicative), detects setups,
and records *simulated* trades in a local database. It does not connect to any broker. It is not financial advice.

## Real-money execution is impossible by construction

- There is no brokerage SDK, order endpoint, broker hostname or order-routing code anywhere in the source tree.
  `server/src/safety.test.ts` scans every production source file for broker vendors, order-placement API names
  and network/process capabilities inside the paper ledger and the pure engine modules; adding any of them fails CI.
- `TRADING_MODE` accepts only `paper`; any other value stops the worker at startup.
- The AI cannot act: its request carries no tools, and its output is sanitized plain text stored on an alert.
- The Day Trader Skill's broker workflow (which relies on an LLM obeying instructions to gate orders) is
  deliberately **not** integrated. Its risk, sizing and entry/exit *ideas* are reimplemented as deterministic,
  tested TypeScript instead.

## Data safety

| Rule | Where enforced |
|---|---|
| Alerts and paper trades use only observations that pass the **freshness gate** | `marketdata/freshness.ts`, used by `worker/tick.ts` for detection and by `worker/trading.ts` for entries |
| No timestamp, stale, unknown delay, end-of-day-only, last-known fallback, or out-of-session data is acted on | same; each rejection is audited with its reason (rate-limited) |
| Entries require a *fresh in-session* quote; exits tolerate session end but never invent a price | `evaluateExit`, `manageOpenPositions` |
| If data disappears while a position is open: high alert after 10 min, flatten at the last mark after 16:15 ET | `worker/trading.ts` |
| Pending signals never fill on stale data | tested (`worker.test.ts`) |
| Provider rate limits respected: shared cache, per-provider limiters, ≤10 candle fetches/cycle, 15 s poll floor | `cache.ts`, `providers/*`, `config.ts` |

## Risk controls (all enforced by the server, not the UI)

Defaults: 0.5% of equity risked per trade, ≤25% of equity per position, ≤3 open positions, ≤6 trades/day,
2% daily loss limit (realized + unrealized), 60-minute re-entry cooldown after a stop-out, entries 09:45–15:30 ET,
flat by 15:55 ET, minimum reward/risk 1.5, price ≥ $5, spread ≤ 0.5%, a **kill switch**.
Every limit is range-checked with a hard ceiling (for example risk per trade can never exceed 2%), both on write
and when loaded: a corrupt or out-of-bounds stored value falls back to the safe defaults. Sizing uses the *fill*
price, so chasing a breakout shrinks the position instead of silently raising risk. Fills slip against the trader.
Positions are never carried overnight.

## Secrets and access

- `API_KEY` protects every engine, portfolio and AI endpoint (constant-time compare). The browser never sees it:
  the Next.js route handler attaches it server-side. Tests assert it is absent from the page and from `localStorage`.
- Telegram token and Anthropic key live only in the server/worker environment. The logger redacts registered secrets
  and token-shaped strings from every line; the Telegram sender scrubs errors (the token is in the URL path); config
  errors never echo values. A test asserts the token is not in the database, audit log or alerts.
- The API binds to `127.0.0.1` by default, CORS allows one origin, and endpoints are rate limited. Do not expose it
  publicly without TLS in front (see `docs/OPERATIONS.md`).
- Telegram is **outbound only**: the bot never reads updates, so there is no remote-command surface.
- User-controlled strings (headlines, symbols) are validated, escaped for Telegram HTML and sanitized before the AI
  prompt; the prompt marks them as untrusted data, and model output is stripped of markup and links.

## Audit trail

Every automated decision (signal detected, risk blocked, paper buy/sell, alert emitted or suppressed, AI call,
Telegram failure, config change, data rejection, worker start, report) is written to `audit_log` and is visible via
`GET /api/audit`. Retention defaults to 90 days; the paper ledger and reports are kept.

## Known limits (be honest with yourself)

- Free data can be wrong, late or rate-limited. Thinly traded symbols often fail the freshness gate by design.
- Paper results are not predictive: no queue position, partial fills, halts or real slippage. Treat them as a
  rough sanity check of a rule set, not a forecast.
- Strategy parameters are unoptimized defaults, not tuned or backtested edge.
