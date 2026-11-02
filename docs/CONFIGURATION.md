# Configuration reference

Every environment variable OpenTerminal reads. None is required for local use: with nothing set you get the
dashboard, paper trading and (when the worker runs) alerts on the dashboard. Telegram and AI are opt-in.

`.env.example` has the same list as a copy-paste template. A test (`server/src/envdocs.test.ts`) fails the
build if the code reads a variable that is missing from this file or from `.env.example`.

> The server does **not** read `.env` files itself. Docker Compose substitutes them; for plain `npm run`
> export the variables in your shell. Never commit a real `.env` (it is git-ignored).

Components: **api** = Express server, **worker** = monitoring process, **web** = Next.js.

## Safety (fixed, not configurable)

| Variable | Component | Default | Notes |
|---|---|---|---|
| `TRADING_MODE` | worker | `paper` | The **only** accepted value is `paper`. Any other value stops the worker at startup (exit code 2). There is no live-trading code path to enable. |

## Core / security

| Variable | Component | Default | Description |
|---|---|---|---|
| `API_KEY` | api, web | generated into `data/.api-key` | Shared secret for every non-market endpoint (`X-Api-Key`). Set it explicitly (same value on api **and** web) for anything reachable beyond localhost. Never exposed to the browser: the web proxy attaches it server-side. |
| `API_KEY_FILE` | web | `../data/.api-key` | Where the web process reads a generated key from when `API_KEY` is unset. |
| `WEB_ORIGIN` | api | `http://localhost:3000` | The only browser origin allowed by CORS. |
| `API_HOST` | api | `127.0.0.1` | Bind address. Keep loopback unless you deliberately expose the API. |
| `API_PORT` | api | `4000` | API port. |
| `API_URL` | web | `http://localhost:4000` | Where the web proxy reaches the API. |
| `TRUST_PROXY` | api | unset | Set to `1` **only** behind exactly one trusted reverse proxy (affects per-IP rate limits). |
| `DATA_DIR` | api, worker | `./data` | Directory for the SQLite database (`terminal.db`), generated key and `backups/`. api and worker must point at the same directory. |

## Market data and freshness

Public endpoints are delayed or indicative, never exchange-grade. These settings only gate **alert and
paper-trade eligibility**; the dashboard still displays whatever data is available, labelled.

| Variable | Component | Default | Description |
|---|---|---|---|
| `MAX_QUOTE_AGE_SEC` | api, worker | `120` | Max age (seconds) of a provider-declared real-time print. Thinly traded symbols may have older last trades and will be rejected as stale; raise it for illiquid names. |
| `MAX_DELAYED_AGE_SEC` | api, worker | `1200` | Max age of a delayed/indicative print (~15 min delay + slack). |
| `ALERT_ALLOW_EXTENDED_HOURS` | api, worker | `false` | Only the literal `true` allows alerts in pre-market/after-hours. |
| `MAX_CANDLE_LAG_SEC` | worker | `900` | Intraday (5-minute) candles whose newest bar is older than this are not used for signals. |
| `SEC_EDGAR_CONTACT` | api | built-in fallback | **Set this to your own email.** SEC requires a contact in the User-Agent. If unset, the upstream project author's address is sent. |
| `YAHOO_USER_AGENT` | api, worker | random pick per process | Pin one Yahoo User-Agent. |

## Monitoring worker

| Variable | Default | Range | Description |
|---|---|---|---|
| `MONITOR_POLL_SECONDS` | `60` | 15–3600 | Cycle interval during market hours. The 15 s floor protects provider rate limits. |
| `MONITOR_IDLE_POLL_SECONDS` | `300` | 60–3600 | Cycle interval outside 09:15–16:30 ET and on weekends. |
| `MONITOR_CANDLE_REFRESH_SECONDS` | `300` | 60–3600 | How often each symbol's 5-minute candles are refreshed. At most 10 candle fetches happen per cycle. |
| `MONITOR_DAILY_REFRESH_SECONDS` | `3600` | 300–86400 | Daily candle refresh interval. |
| `MONITOR_MAX_SYMBOLS` | `40` | 1–150 | Watchlist symbols monitored (extras are skipped and audited). Each symbol costs provider requests. |
| `MONITOR_NEWS_ENABLED` | `true` | bool | Headline monitoring (low-importance alerts; never sent to Telegram or the AI by default). |
| `MONITOR_NEWS_REFRESH_SECONDS` | `900` | 300–86400 | News refresh interval (5 symbols per refresh, rotating). |
| `ALERT_DAILY_CAP` | `60` | 1–1000 | Alerts per ET day; high-importance alerts get double headroom. |
| `DATA_RETENTION_DAYS` | `90` | 7–3650 | Audit log, alerts and events older than this are pruned daily. The paper ledger and reports are kept. |
| `PAPER_STARTING_CASH` | `100000` | 1000–1e9 | Starting paper cash, applied when the database is first created. |
| `LOG_LEVEL` | `info` | debug/info/warn/error | Structured JSON logs on stdout/stderr. Secrets are redacted. |

Risk limits (risk per trade, max positions, daily loss limit, kill switch, ...) are **not** environment
variables: they live in the database, are edited from the dashboard (Monitor → Risk) or `PUT /api/risk/config`,
and are range-checked by the server. See `docs/SAFETY.md`.

## Telegram notifications (optional)

Outbound only: the bot never reads messages, so there is no inbound command surface.

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | unset | From [@BotFather](https://t.me/BotFather). Both token and chat id are needed to enable. |
| `TELEGRAM_CHAT_ID` | unset | Numeric chat id (or `@channelname`). Message your bot once, then read your id from `https://api.telegram.org/bot<token>/getUpdates`. |
| `TELEGRAM_ENABLED` | `true` | Set `false` to disable without removing the credentials. |
| `TELEGRAM_MIN_IMPORTANCE` | `normal` | `low`, `normal` or `high`: the minimum importance that is sent. |
| `TELEGRAM_DAILY_CAP` | `40` | Messages per ET day (high-importance alerts bypass the cap). |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | Override for tests or a proxy. |

## AI analysis (optional, event-triggered, hard budget)

The model is called **only** for a specific detected event (never per quote update), at most `AI_DAILY_CALL_LIMIT`
times per ET day, and its output is plain text attached to the alert. It cannot place orders or call tools.

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Required to enable AI features (dashboard assistant and event analysis). |
| `ANTHROPIC_BASE_URL` | Anthropic API | Anthropic-compatible gateway (also how a local model gateway would be plugged in). |
| `ANTHROPIC_MODEL` | – | Model id for the assistant; also the fallback for `AI_MODEL`. |
| `AI_MODEL` | `ANTHROPIC_MODEL` or `claude-sonnet-5-5` | Model for event analysis. |
| `AI_ENABLED` | `true` | `false` disables event analysis even with a key. |
| `AI_DAILY_CALL_LIMIT` | `10` | Hard cap per ET day (0 disables). Failed calls count. |
| `AI_MAX_TOKENS` | `500` | Output cap per call. |
| `AI_MIN_INTERVAL_SEC` | `30` | Minimum spacing between calls. |
| `AI_TIMEOUT_MS` | `30000` | Per-call timeout. |
| `AI_MIN_IMPORTANCE` | `normal` | Minimum alert importance eligible for analysis. |
