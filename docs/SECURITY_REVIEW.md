# Security review (release 0.2.0)

Scope: the API, web proxy, worker, SQLite layer, Docker deployment, dependencies and secret handling. Method: code reading of every trust
boundary, then automated tests and live attack simulation against real running processes/containers. **This is a self-review by the
developer-assistant, not an independent audit.**

## Findings fixed in this release

| # | Finding | Severity | Fix | Evidence |
|---|---|---|---|---|
| 1 | Dashboard proxy attached the API key to **any** request: a cross-site form POST could run state-changing calls | High | Custom-header + same-origin proof for mutations | Unit tests; curl attacks; real cross-origin attacker page (`e2e/csrf.cjs`) fails on every vector |
| 2 | Same proxy exposed account data to **DNS rebinding** (attacker domain rebound to 127.0.0.1) | High | `Host` allow-list (`ALLOWED_HOSTS`) | Unit + live tests |
| 3 | 10 dependency advisories incl. unauthenticated RCE in Next.js image optimization, `proxy-addr` IP spoofing | Critical | Patched/compatible upgrades (+ two overrides) | `npm audit` = 0 for all deps; CI enforces |
| 4 | Telegram bot token travels in the URL path and could surface in error text | Medium | Scrubbed in HTTP errors, sender and logger | Tests incl. canary-secret scans of DB, logs, every GET response |
| 5 | Provider requests had no timeout (a hung provider held slots forever) | Medium | 10 s hard timeout incl. body | Tests |
| 6 | Docker Compose passes unset vars as `""`; config treated that as invalid (availability) | Medium | Empty = unset everywhere | Regression tests; found by real container run |
| 7 | Unvalidated route params, silent 204s, blanket error mapping in portfolio routes | Low | Strict validation, honest status codes | Tests |
| 8 | Data directory and backups world-readable | Low | `0700` | Test |

## Verified properties
- Every engine/portfolio/AI endpoint requires the API key (authorization matrix test over all routes); near-miss keys, query-string/cookie/bearer keys, spoofed `X-Forwarded-For`/`Host` are rejected; a flood (including key guessing) is rate limited even for the correct key.
- SQL/markup/traversal payloads across every parameter produce no 5xx, run no statement, and leave all tables intact; all SQL is parameterized.
- No credential appears in any API response, log line, audit row, alert or database table (canary scans).
- Containers: non-root, read-only rootfs, zero capabilities, `no-new-privileges`, loopback-only ports; the web tier holds no third-party credentials.
- No brokerage code, hostnames or order APIs exist anywhere in the source (scanned by CI).

## Residual risks and recommendations
- **No application login.** Anyone who can reach port 3000 can use the dashboard (including editing paper settings and the kill switch). Keep it on loopback/tailnet, or add authentication at a reverse proxy.
- **Free data providers** are unofficial and scraped; their terms may restrict automated use, and responses are untrusted input (parsed defensively, never executed).
- **Prompt injection** via headlines is mitigated (untrusted-data framing, no tools, sanitized plain-text output, tiny budget), not eliminated; the worst case is a misleading sentence on a paper-trading alert.
- **Single-host SQLite** has no replication: back up off-machine (docs/OPERATIONS.md).
- `npm audit` covers known advisories only. Re-run on every release; consider an SCA tool and dependency pinning review for long-lived deployments.
- GitHub Actions additions are validated locally but not yet executed on GitHub.
