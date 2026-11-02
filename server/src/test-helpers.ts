import Database from "better-sqlite3";
import { DEFAULT_WATCHLIST_SYMBOLS, runMigrations } from "./migrations.js";

/** Fresh in-memory database with the full schema and the same first-run seeds as db.ts. */
export function makeDb(opts: { cash?: number; seedWatchlist?: boolean } = {}): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const cash = opts.cash ?? 100_000;
  db.prepare("INSERT INTO paper_account (id, starting_cash, cash, created_at) VALUES (1, ?, ?, 0)").run(cash, cash);
  if (opts.seedWatchlist) {
    const id = Number(db.prepare("INSERT INTO watchlists (name) VALUES ('Default')").run().lastInsertRowid);
    DEFAULT_WATCHLIST_SYMBOLS.forEach((s, i) => db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)").run(id, s, i));
  }
  return db;
}
