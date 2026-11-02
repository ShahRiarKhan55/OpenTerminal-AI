import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_WATCHLIST_SYMBOLS, runMigrations } from "./migrations.js";

// DATA_DIR lets the Docker image point this at the mounted volume: once
// compiled, dist/db.js sits two levels below /app instead of server/src, so
// the source-relative default below would otherwise resolve outside /app.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const dataDir = process.env.DATA_DIR ?? join(root, "data");
export const backupDir = join(dataDir, "backups");
mkdirSync(dataDir, { recursive: true });
mkdirSync(backupDir, { recursive: true });

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

// First-run seeds (idempotent).
if (!db.prepare("SELECT id FROM portfolios LIMIT 1").get()) {
  db.prepare("INSERT INTO portfolios (name) VALUES (?)").run("Main");
}
if (!db.prepare("SELECT id FROM watchlists LIMIT 1").get()) {
  const seed = db.transaction(() => {
    const id = Number(db.prepare("INSERT INTO watchlists (name) VALUES ('Default')").run().lastInsertRowid);
    const ins = db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)");
    DEFAULT_WATCHLIST_SYMBOLS.forEach((s, i) => ins.run(id, s, i));
  });
  seed();
}
if (!db.prepare("SELECT id FROM paper_account WHERE id = 1").get()) {
  const cash = Number(process.env.PAPER_STARTING_CASH);
  const start = Number.isFinite(cash) && cash >= 1000 && cash <= 1e9 ? cash : 100_000;
  db.prepare("INSERT INTO paper_account (id, starting_cash, cash, created_at) VALUES (1, ?, ?, ?)").run(start, start, Date.now());
}
