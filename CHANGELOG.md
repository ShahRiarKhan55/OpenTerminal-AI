# Changelog

## 0.2.0: Day-trader monitor, paper trading, hardened deployment

**Paper trading only. No real-money execution exists** (enforced by tests that scan the source tree).

### Added
- **Monitoring worker** (separate process): polls the server-side watchlist, applies a fail-closed **freshness gate** to every price,
  detects deterministic setups (opening-range breakout, 20-day breakout) and events (large moves, volume spikes, RSI extremes,
  52-week highs, high-impact economic releases, headlines), and keeps a heartbeat, market-conditions snapshot, and daily/weekly reports.
- **Risk engine and paper broker**: risk-per-trade sizing from the fill price, position/cash caps, max positions and trades/day,
  daily-loss limit, symbol cooldown, entry window, reward/risk and liquidity gates, kill switch, slippage against the trader,
  breakeven stop, flat-by and session-end flattening. Transactional, idempotent ledger.
- **Alerts**: persistent de-duplication, daily caps, full **audit log**; dashboard Alert Center; **Telegram** (outbound only, retry/backoff, caps).
- **Event-triggered Claude analysis** with a hard daily call budget, minimum spacing, duplicate suppression, sanitized output, and a
  pluggable provider interface (local model later). Never called per quote update; never able to act.
- **Dashboard**: Alerts & Signals, Paper Trading and Monitor widgets; server-backed watchlist; data-age/"alert-grade" labels on quotes;
  PAPER badge and worker health in the top bar; one-click Day Trader layout.
- **Operations**: versioned SQLite migrations with automatic pre-migration backups; online consistent backup and guarded restore;
  worker health check; hardened Docker Compose (non-root, read-only rootfs, no capabilities, least-privilege credentials, rotated logs);
  complete configuration reference and operations guide.
- **Acceptance suite** (`npm run e2e`): real browser against a seeded real stack, cross-origin attacker simulation, compiled-worker smoke test.

### Security
- Fixed **CSRF** and **DNS-rebinding** exposure in the dashboard proxy (it attached the API key to any request): mutations now require a
  custom header and same-origin proof; the `Host` header is allow-listed (`ALLOWED_HOSTS`); path traversal, oversized bodies and
  upstream failures are handled; verified with a real cross-origin attacker page.
- API: body limit, JSON error handlers (no stack traces), security headers, no framework banner, owner-only data directory.
- **Dependencies: 10 known advisories (2 critical, including an unauthenticated RCE in Next.js image optimization) to 0**,
  including dev tooling; CI now fails on any new advisory at "high" or above.
- Timeouts on every provider request; secrets redacted from logs and errors (Telegram tokens live in URL paths).

### Fixed
- Empty-string environment variables (as Docker Compose passes them) made the worker refuse to start; empty now means unset everywhere.
- Nasdaq empty fields (bid/ask/price/volume) were parsed as 0 instead of unknown.
- Portfolio routes: strict ids, 404s for missing resources, validated dates, cascading deletes.
- Stale last-known quotes could be served without saying so; every quote now carries delay class, provider time and a freshness verdict.

### Known limitations
- Free public data is delayed or indicative and can be rate-limited (Yahoo often limits datacenter IPs); intraday (ORB) signals need Yahoo 5-minute bars.
- Thinly traded symbols commonly fail the freshness gate by design.
- Strategy parameters are unoptimized defaults; paper results are not predictive.
- US stocks and ETFs only (the data model is ready for crypto; see docs/ARCHITECTURE.md).
- The dashboard has no login of its own: keep it on loopback or a private network, or put authentication in front (docs/OPERATIONS.md).
- The GitHub Actions workflow additions were validated by running their steps locally; they have not yet run on GitHub.

## 0.1.0
Initial import of OpenTerminal (upstream) with the Phase 0/1 data-trust groundwork.
