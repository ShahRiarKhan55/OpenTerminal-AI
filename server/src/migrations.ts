import type Database from "better-sqlite3";
import { existsSync } from "node:fs";

/**
 * Ordered, append-only schema migrations. The applied version is stored in
 * SQLite's `PRAGMA user_version`. NEVER edit or reorder a shipped migration:
 * add a new one. Each migration runs in its own transaction, so a failure
 * leaves the database at the previous version.
 */
export type Migration = { version: number; name: string; sql: string };

export const DEFAULT_WATCHLIST_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "SPY"];

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "portfolio-baseline",
    // IF NOT EXISTS: databases created by the pre-migration code already have these.
    sql: `
CREATE TABLE IF NOT EXISTS portfolios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity REAL NOT NULL CHECK (quantity > 0),
  price REAL NOT NULL CHECK (price >= 0),
  executed_at TEXT NOT NULL
);`,
  },
  {
    version: 2,
    name: "watchlists-settings-worker-state",
    sql: `
CREATE TABLE watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE watchlist_items (
  watchlist_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (watchlist_id, symbol)
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE worker_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`,
  },
  {
    version: 3,
    name: "events-alerts-signals-audit",
    sql: `
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  symbol TEXT,
  type TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance IN ('low','normal','high')),
  dedupe_key TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX events_dedupe ON events(dedupe_key, created_at);
CREATE INDEX events_created ON events(created_at);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  symbol TEXT,
  type TEXT NOT NULL,
  importance TEXT NOT NULL CHECK (importance IN ('low','normal','high')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data_label TEXT,
  ai_status TEXT NOT NULL DEFAULT 'none' CHECK (ai_status IN ('none','done','skipped_budget','skipped_disabled','failed')),
  ai_analysis TEXT,
  acknowledged_at INTEGER,
  telegram_status TEXT NOT NULL DEFAULT 'none' CHECK (telegram_status IN ('none','pending','sent','failed','skipped_cap')),
  telegram_attempts INTEGER NOT NULL DEFAULT 0,
  telegram_next_at INTEGER,
  telegram_error TEXT
);
CREATE INDEX alerts_created ON alerts(created_at);
CREATE INDEX alerts_telegram ON alerts(telegram_status, telegram_next_at);

CREATE TABLE signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side = 'LONG'),
  status TEXT NOT NULL CHECK (status IN ('pending','filled','blocked','expired','invalidated','skipped_chase')),
  entry REAL NOT NULL,
  stop REAL NOT NULL,
  target REAL NOT NULL,
  risk_per_share REAL NOT NULL,
  reward_risk REAL NOT NULL,
  valid_until INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  risk_verdict TEXT,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE (strategy, symbol, session_date)
);
CREATE INDEX signals_status ON signals(status, created_at);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  symbol TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  detail TEXT
);
CREATE INDEX audit_ts ON audit_log(ts);
CREATE INDEX audit_kind ON audit_log(kind, ts);`,
  },
  {
    version: 4,
    name: "paper-trading-ai-reports",
    sql: `
CREATE TABLE paper_account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  starting_cash REAL NOT NULL CHECK (starting_cash > 0),
  cash REAL NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER UNIQUE REFERENCES signals(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side = 'LONG'),
  qty REAL NOT NULL CHECK (qty > 0),
  entry_price REAL NOT NULL,
  initial_stop REAL NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  risk_per_share REAL NOT NULL,
  opened_at INTEGER NOT NULL,
  session_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','closed')),
  last_price REAL,
  last_price_at INTEGER,
  exit_price REAL,
  closed_at INTEGER,
  exit_reason TEXT,
  realized_pnl REAL,
  r_multiple REAL,
  fees REAL NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX positions_status ON paper_positions(status, opened_at);
CREATE TABLE paper_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL REFERENCES paper_positions(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  kind TEXT NOT NULL,
  qty REAL NOT NULL,
  price REAL NOT NULL,
  fee REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  alert_id INTEGER,
  payload_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','ok','error')),
  input_tokens INTEGER,
  output_tokens INTEGER,
  error TEXT
);
CREATE INDEX ai_calls_day ON ai_calls(day);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('daily','weekly')),
  period_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (kind, period_key)
);`,
  },
  {
    version: 5,
    name: "investment-holdings",
    sql: `
CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('mutual_fund','commodity_fund','etf','stock','crypto','other')),
  symbol TEXT,
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency = upper(currency)),
  units REAL NOT NULL CHECK (units >= 0),
  avg_price REAL NOT NULL CHECK (avg_price >= 0),
  -- Quoted prices are per \`price_unit\` units: 1 for stocks/crypto, 10000 for Japanese mutual-fund NAVs (per 10,000 units).
  price_unit INTEGER NOT NULL DEFAULT 1 CHECK (price_unit IN (1, 10000)),
  price_source TEXT NOT NULL DEFAULT 'manual' CHECK (price_source IN ('manual','quote')),
  manual_price REAL CHECK (manual_price IS NULL OR manual_price >= 0),
  manual_price_as_of TEXT,
  manual_price_updated_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX holdings_currency ON holdings(currency);`,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

function hasUserTables(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portfolios'").get());
}

export type MigrationResult = { from: number; to: number; applied: string[]; backupPath: string | null };

/**
 * Apply pending migrations. If an existing database (one that already holds
 * data) is about to change, take a consistent copy first via VACUUM INTO, so
 * a bad upgrade can be undone by restoring that file.
 */
export function runMigrations(
  db: Database.Database,
  opts: { backupDir?: string; migrations?: Migration[]; now?: () => number; _afterPlan?: () => void } = {}
): MigrationResult {
  const migrations = opts.migrations ?? MIGRATIONS;
  const from = db.pragma("user_version", { simple: true }) as number;
  const latestKnown = migrations[migrations.length - 1].version;
  // Checked BEFORE the "nothing pending" shortcut: a database written by a newer
  // build must never be opened by older code (e.g. after a rollback of the app).
  if (from > latestKnown) {
    throw new Error(`database schema v${from} is newer than this build (v${latestKnown}); refusing to run`);
  }
  const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  const result: MigrationResult = { from, to: from, applied: [], backupPath: null };
  if (pending.length === 0) return result;

  if (opts.backupDir && (from > 0 || hasUserTables(db))) {
    const stamp = new Date((opts.now ?? Date.now)()).toISOString().replace(/[:.]/g, "-");
    const path = `${opts.backupDir}/pre-migration-v${from}-${stamp}.db`;
    try {
      db.prepare("VACUUM INTO ?").run(path);
      result.backupPath = path;
    } catch (err) {
      // A concurrently starting process may have just written the same file; any other failure is fatal.
      if (!existsSync(path)) throw err;
      result.backupPath = path;
    }
  }

  opts._afterPlan?.(); // test seam: lets a test interleave a competing process here

  for (const m of pending) {
    // The API and the worker are separate processes and may start together. IMMEDIATE takes the
    // write lock up front, and the version is re-read INSIDE it, so exactly one process applies
    // each migration and the other skips it instead of failing on "table already exists".
    const apply = db.transaction((): boolean => {
      const current = db.pragma("user_version", { simple: true }) as number;
      if (current >= m.version) return false;
      db.exec(m.sql);
      db.pragma(`user_version = ${Math.trunc(m.version)}`);
      return true;
    });
    if (apply.immediate()) result.applied.push(`${m.version}:${m.name}`);
    result.to = m.version;
  }
  return result;
}
