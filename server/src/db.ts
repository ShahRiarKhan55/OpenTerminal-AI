import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WATCHLIST_SYMBOLS, runMigrations } from "./migrations.js";

// DATA_DIR lets the Docker image point this at the mounted volume: once
// compiled, dist/db.js sits two levels below /app instead of server/src, so
// the source-relative default below would otherwise resolve outside /app.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const dataDir = process.env.DATA_DIR || join(root, "data");
export const backupDir = join(dataDir, "backups");
// The database, backups and generated API key are private to this user.
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
mkdirSync(backupDir, { recursive: true, mode: 0o700 });

export const db = new Database(join(dataDir, "terminal.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// The API and the monitoring worker are separate processes sharing this file:
// wait briefly for a competing writer instead of failing with SQLITE_BUSY.
db.pragma("busy_timeout = 5000");
db.pragma("synchronous = NORMAL");

const migration = runMigrations(db, { backupDir });
if (migration.applied.length > 0) {
  console.log(
    `[db] migrated v${migration.from} -> v${migration.to} (${migration.applied.join(", ")})` +
      (migration.backupPath ? `; pre-migration backup: ${migration.backupPath}` : "")
  );
}

// First-run seeds. Idempotent and race-safe: the API and the worker can start at the same time,
// so every insert is OR IGNORE and keyed on a unique name/primary key.
db.prepare("INSERT OR IGNORE INTO portfolios (name) VALUES ('Main')").run();
db.transaction(() => {
  db.prepare("INSERT OR IGNORE INTO watchlists (name) VALUES ('Default')").run();
  const id = (db.prepare("SELECT id FROM watchlists WHERE name = 'Default'").get() as { id: number }).id;
  const empty = !db.prepare("SELECT 1 FROM watchlist_items WHERE watchlist_id = ? LIMIT 1").get(id);
  const hasOthers = (db.prepare("SELECT COUNT(*) AS c FROM watchlists").get() as { c: number }).c > 1;
  // Seed the starter symbols only into a brand-new Default list, never into one the user emptied on purpose.
  const seededBefore = db.prepare("SELECT 1 FROM settings WHERE key = 'watchlist_seeded'").get();
  if (empty && !hasOthers && !seededBefore) {
    const ins = db.prepare("INSERT OR IGNORE INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
    DEFAULT_WATCHLIST_SYMBOLS.forEach((s, i) => ins.run(id, s, i));
  }
  db.prepare("INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('watchlist_seeded', '1', ?)").run(Date.now());
}).immediate();
{
  const cash = Number(process.env.PAPER_STARTING_CASH);
  const start = Number.isFinite(cash) && cash >= 1000 && cash <= 1e9 ? cash : 100_000;
  db.prepare("INSERT OR IGNORE INTO paper_account (id, starting_cash, cash, created_at) VALUES (1, ?, ?, ?)").run(start, start, Date.now());
}
