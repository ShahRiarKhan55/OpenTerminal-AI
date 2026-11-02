# Operations guide

How to run OpenTerminal AI as an always-on service: deploy, monitor, back up, restore, upgrade and roll back.
Everything marked **verified** was exercised against real containers during release testing.

> **Paper trading only.** Nothing here can place a real order. Prices are delayed or indicative.
> **This guide describes how to deploy; nothing has been deployed for you.**

## 1. Topology

| Service | Role | Port (loopback only) | Reads/writes |
|---|---|---|---|
| `api` | HTTP API, applies DB migrations | `127.0.0.1:4000` | `/data` read-write |
| `worker` | Monitoring + paper trading + alerts + Telegram + AI | none | `/data` read-write |
| `web` | Dashboard; attaches the API key server-side | `127.0.0.1:3000` | `/data` read-only |
| `backup` | On-demand backup job (profile `tools`) | none | `/data` read-write |

All state lives in one SQLite database on the `terminal-data` volume. The application has **no login of its own**:
whoever can reach the web port can use the dashboard. Keep it on loopback and reach it through an SSH tunnel or a
private network (section 3); put authentication in front of it if you ever publish it.

## 2. First deployment (VPS checklist)

Do these once on a fresh Linux VPS (Ubuntu 24.04 LTS or Debian 12/13 assumed; 2 vCPU / 2 GB RAM is plenty).

1. **Harden the host.** Create a non-root sudo user; install your SSH key; set `PasswordAuthentication no` and
   `PermitRootLogin no` in `/etc/ssh/sshd_config`; enable automatic security updates
   (`sudo apt install unattended-upgrades`); enable a firewall that allows only SSH (`sudo ufw allow OpenSSH && sudo ufw enable`).
   Do **not** open ports 3000/4000: they are bound to loopback anyway.
2. **Install Docker Engine + Compose plugin** from Docker's official apt repository.
3. **Get the code** at the release tag: `git clone https://github.com/<you>/OpenTerminal-AI.git /opt/openterminal && cd /opt/openterminal && git checkout v0.2.0`.
4. **Configure secrets** (never commit them):
   ```bash
   cp .env.example .env && chmod 600 .env
   # API_KEY:  openssl rand -hex 32
   # SEC_EDGAR_CONTACT: your own email
   # optional: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, ANTHROPIC_API_KEY (+ AI_DAILY_CALL_LIMIT)
   ```
   Every variable is described in [CONFIGURATION.md](CONFIGURATION.md). Leave `TRADING_MODE=paper` (it is the only valid value).
5. **Start:** `docker compose up -d --build`, then `docker compose ps`. All three services should become `healthy`
   (the worker within ~2 minutes).
6. **Smoke test:** `curl -s http://127.0.0.1:3000/api/monitor/status` should show `"running": true` and `"mode": "paper"`.
7. **Schedule backups** (section 5) and **test a restore once** before you rely on it.

### Reaching the dashboard

- **SSH tunnel (simplest, no public exposure):** `ssh -L 3000:127.0.0.1:3000 you@your-vps`, then open `http://localhost:3000`.
- **Private network (recommended for daily use):** install [Tailscale](https://tailscale.com) (or WireGuard) on the VPS and your devices,
  then browse to the VPS's tailnet name. Add that hostname to `ALLOWED_HOSTS` (the web proxy refuses unknown `Host` headers,
  which is what defeats DNS-rebinding attacks).
- **Public HTTPS (only with authentication in front):** terminate TLS and authenticate with a reverse proxy on the host.
  Example Caddyfile (`caddy hash-password` produces the hash); keep compose ports on loopback and set `ALLOWED_HOSTS=terminal.example.com`:
  ```
  terminal.example.com {
      basic_auth { you <hash> }
      reverse_proxy 127.0.0.1:3000
  }
  ```
  If another proxy sits in front of `web`, set `TRUST_PROXY=1` on the API only if you understand the rate-limit implications (see the README).

## 3. Monitoring

- **Container health (verified):** `docker compose ps`. The worker is healthy iff a monitoring cycle completed within
  `HEALTH_MAX_AGE_SEC` (900 s default). Restart policy `unless-stopped` plus a process-level hang watchdog mean a crash or
  a hung cycle ends in an automatic restart.
- **Application view:** the **Monitor** widget (or `GET /api/monitor/status`): worker heartbeat age, cycle time, errors, data-quality
  counts, AI budget, Telegram state. The top bar shows `MON ●`/`○` and unread alerts at all times.
- **Logs:** structured JSON, one object per line, secrets redacted. Rotated by Docker (10 MB x 5 files per container).
  ```bash
  docker compose logs -f worker | jq -c 'select(.level != "debug")'
  docker compose logs --since 1h api worker | grep -E '"level":"(warn|error)"'
  ```
  Messages worth knowing: `tick step failed` (a step errored; the cycle continued), `candle fetch failed` (provider trouble, rate-limited
  to one line per symbol per 15 min), `tick exceeded its time limit` (hang watchdog), `telegram delivery failed`, `ai analysis failed`.
- **Audit trail:** every automated decision is queryable: `GET /api/audit?kind=risk|data|order|alert|ai|system&symbol=AAPL`.
- **Know when it is down, independently of it:** the app cannot tell you it is dead. Use an external check: for example a cron
  job on another machine (or a free uptime service) that calls `/api/monitor/status` through your tunnel/tailnet and alerts you if
  `worker.running` is false. Example (adapt, then test it):
  ```bash
  curl -fsS --max-time 10 -H "X-Api-Key: $API_KEY" http://<vps>:4000/api/monitor/status | jq -e '.worker.running' >/dev/null \
    || curl -s "https://api.telegram.org/bot$TOKEN/sendMessage" -d chat_id=$CHAT -d text="OpenTerminal monitor is DOWN"
  ```

## 4. Restart and crash recovery (verified)

All durable state is in SQLite, so any restart resumes cleanly: pending signals, open paper positions, de-duplication history,
the AI budget and the Telegram outbox survive. On start the worker records the downtime and, if paper positions were open for more than five
minutes without monitoring, raises a high-importance "monitor restarted" alert. Stops/targets are re-evaluated on the first fresh quote;
positions left over from a previous session are flattened, never carried overnight.
`kill -9` of the worker -> container restarts and is healthy again in ~30 s. `docker compose stop worker` completes in ~1 s with exit code 0.

## 5. Backups and restore (verified)

**Never copy `terminal.db` with `cp`/`rsync` while services run:** SQLite keeps recent writes in a `-wal` file and a naive copy is silently incomplete.
Use the backup job, which takes a transactionally consistent snapshot while everything keeps running, verifies it, and prunes old ones:

```bash
docker compose run --rm backup                       # writes /data/backups/terminal-<UTC timestamp>.db, keeps the newest BACKUP_KEEP (14)
docker compose run --rm --no-deps --entrypoint ls backup /data/backups
```

Schedule it (host crontab, daily 02:15) **and copy backups off the machine** (a backup on the same disk is not a backup):

```cron
15 2 * * * cd /opt/openterminal && docker compose run --rm backup >> /var/log/openterminal-backup.log 2>&1
30 2 * * * rclone copy "$(docker volume inspect openterminal_terminal-data -f '{{.Mountpoint}}')/backups" remote:openterminal-backups --include "terminal-*.db"
```

**Restore:**

```bash
docker compose stop api worker web                                  # nothing may use the database during a restore
docker compose run --rm --no-deps --entrypoint node backup \
    dist/scripts/restore.js /data/backups/terminal-20261102T152036Z.db --confirm-stopped
docker compose up -d
```

The restore refuses a missing/corrupt/foreign file or a backup from a **newer** schema than the running version, and it never deletes the database
it replaces: that is kept as `/data/backups/pre-restore-<timestamp>.db` so a mistaken restore can itself be undone.
Older backups are upgraded automatically by the normal migrations on the next start. Before any schema migration the application also writes
`/data/backups/pre-migration-v<from>-<timestamp>.db` automatically.

Rehearse a restore on a scratch copy at least once. Deleting the volume (`docker compose down -v`) destroys all data.

## 6. Upgrades and rollback

```bash
cd /opt/openterminal
docker compose run --rm backup                 # always back up first
git fetch --tags && git checkout v0.X.Y        # a release tag, never an untested branch
docker compose build && docker compose up -d   # migrations run automatically, with a pre-migration backup
docker compose ps && curl -s http://127.0.0.1:3000/api/monitor/status
```

Rollback: `git checkout <previous tag> && docker compose build && docker compose up -d`. If the new version migrated the schema, the old
version will **refuse to start** against it (by design: it cannot understand the newer schema); restore the `pre-migration-*.db` or the
pre-upgrade backup first (section 5), then start the old version. Keep the previous image/tag until the new one has run through a market day.

Dependency updates: CI fails on any advisory at "high" or above (`npm audit`); fix with `npm audit fix` or an upgrade, run the full test suite,
and release as a new tag.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Monitor shows `WORKER NOT STARTED/STALLED` | `docker compose ps`; `docker compose logs worker`. Config errors exit with code 2 and list every problem (values are never printed). |
| No alerts at all | Normal outside 09:30-16:00 ET and on holidays. During the session, check Monitor -> "with alert-grade data now": if 0, quotes are failing the freshness gate (stale, delayed beyond limits, or pre-market). `GET /api/audit?kind=data` shows the exact reason per symbol. |
| Many `candle fetch failed ... 429` | Yahoo is rate-limiting your IP (shared/cloud IPs often are). The worker backs off and intraday (ORB) signals pause; daily-based detection and exits continue. Reduce `MONITOR_MAX_SYMBOLS`, raise `MONITOR_CANDLE_REFRESH_SECONDS`, or use a different egress IP. |
| Thinly traded symbols never alert | Their last trade is older than `MAX_QUOTE_AGE_SEC`. By design they are rejected; raise the limit only if you accept less certain freshness. |
| Telegram messages missing | Monitor shows Telegram `configured`? Check `TELEGRAM_MIN_IMPORTANCE`/`TELEGRAM_DAILY_CAP`; failures are in `GET /api/audit?kind=notify`. A permanent error (bad token/chat id, blocked bot) stops delivery attempts and is logged once. |
| AI notes missing | Daily budget spent (Monitor shows `used/limit`), the alert is below `AI_MIN_IMPORTANCE`, or the key is unset. Alerts are always delivered without the note. |
| `host not allowed` in the browser | You are using a hostname that is not in `ALLOWED_HOSTS`. |
| Dashboard `403 missing anti-CSRF header` | A script or old cached page is sending state-changing requests without `X-Requested-With: openterminal`. Reload the page. |
| Disk usage grows | Logs are capped by Docker rotation; the audit log/alerts prune after `DATA_RETENTION_DAYS`; backups are capped by `BACKUP_KEEP`; `pre-restore-*`/`pre-migration-*` copies are never auto-deleted: remove old ones by hand. |

## 8. Hosting options and cost (indicative: verify before you buy)

The workload is small: a Node API, a Node worker polling about 40 symbols once a minute, and a Next.js server. **2 vCPU / 2 GB RAM / 20+ GB disk**
is comfortable; 1 GB works but is tight while building images (build on a bigger machine or add swap). Egress must be unrestricted HTTPS.
Prices below come from third-party roundups and **disagree with each other**; several providers changed prices during 2026. Treat them as
order-of-magnitude and check the provider's own pricing page.

| Option | Indicative cost | Notes |
|---|---|---|
| **Small VPS: Hetzner Cloud** | roughly €4-8 / month for a 2 vCPU / 2-4 GB shared plan | Best value; EU and US regions. Reports of price rises and plan renames in 2026 ([sources](https://www.vincentschmalbach.com/hetzner-cheap-cloud-unavailable-price-increases/), [pricing roundup](https://agentdeals.dev/hetzner-pricing-2026)). Prefer a US-East location for lower latency to US data sources. |
| **Small VPS: DigitalOcean / Vultr / Linode** | roughly $6-18 / month (1 GB ~$6; 2 GB higher) | Simple, good docs, US regions ([sources](https://www.websiteplanet.com/blog/digitalocean-pricing-plans), [price notes](https://costbench.com/changelog/digitalocean-price-decrease-2026-02/)). |
| **AWS Lightsail** | about $5 (512 MB), $7 (1 GB), $12 (2 GB) / month | Fine, with an AWS account's complexity and add-on charges for snapshots/storage ([sources](https://kuberns.com/blogs/aws-lightsail-pricing-your-comprehensive-guide/)). |
| **Home server / mini PC / Raspberry Pi 5** | hardware once (~$80-250) + a few dollars of power | Cheapest long term and your data stays home; you own power, internet, and uptime. A residential IP is often *less* rate-limited by free data providers than a datacenter IP. |
| **PaaS (Fly.io, Railway, Render)** | roughly $5-15 / month | Not recommended here: SQLite on a single persistent volume with two cooperating processes sharing one file is awkward on PaaS (they often isolate processes). |

**Recommendation:** a 2 GB VPS (Hetzner or DigitalOcean, US-East if offered) running this Compose file, reached over Tailscale, with the daily backup copied
off-box. Expect on the order of **$5-12/month** for the server, plus Claude API usage, which you cap yourself (`AI_DAILY_CALL_LIMIT`, default 10 short calls/day:
typically well under a dollar a day) and Telegram, which is free.
Free data sources have no SLA: a datacenter IP being rate-limited by Yahoo/Nasdaq is the most likely operational annoyance, and the system is built to degrade
(skipping intraday signals, never guessing) rather than fail.
