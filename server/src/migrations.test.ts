import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ot-mig-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
    .map((r) => r.name)
    .sort();

describe("runMigrations", () => {
  it("builds the full schema on a fresh database, with no backup", () => {
    const db = new Database(":memory:");
    const r = runMigrations(db, { backupDir: dir });
    expect(r.from).toBe(0);
    expect(r.to).toBe(LATEST_VERSION);
    expect(r.backupPath).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect(tables(db)).toEqual(
      [
        "ai_calls", "alerts", "audit_log", "events", "paper_account", "paper_orders", "paper_positions",
        "portfolios", "reports", "settings", "signals", "transactions", "watchlist_items", "watchlists", "worker_state",
      ].sort()
    );
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
  });

  it("is idempotent", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const again = runMigrations(db);
    expect(again.applied).toEqual([]);
    expect(again.from).toBe(again.to);
  });

  it("versions are unique, contiguous and ascending (append-only discipline)", () => {
    MIGRATIONS.forEach((m, i) => expect(m.version).toBe(i + 1));
  });

  it("upgrades a legacy (pre-migration) database without losing data, and backs it up first", () => {
    const file = join(dir, "legacy.db");
    const legacy = new Database(file);
    // Exactly what the old db.ts created, with user_version still 0.
    legacy.exec(`
      CREATE TABLE portfolios (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('BUY','SELL')), quantity REAL NOT NULL CHECK (quantity > 0),
        price REAL NOT NULL CHECK (price >= 0), executed_at TEXT NOT NULL);
      INSERT INTO portfolios (name) VALUES ('Main');
      INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (1,'AAPL','BUY',10,100,'2026-01-01T00:00:00Z');
    `);
    expect(legacy.pragma("user_version", { simple: true })).toBe(0);

    const backupDir = join(dir, "backups");
    mkdirSync(backupDir);
    const r = runMigrations(legacy, { backupDir, now: () => Date.UTC(2026, 10, 2, 12, 0, 0) });
    expect(r.to).toBe(LATEST_VERSION);
    expect(r.backupPath).toMatch(/pre-migration-v0-2026-11-02T12-00-00-000Z\.db$/);
    expect(existsSync(r.backupPath!)).toBe(true);

    // data intact
    expect((legacy.prepare("SELECT COUNT(*) c FROM transactions").get() as { c: number }).c).toBe(1);
    // backup is the OLD schema + data (no new tables), restorable on its own
    const bak = new Database(r.backupPath!, { readonly: true });
    expect((bak.prepare("SELECT COUNT(*) c FROM transactions").get() as { c: number }).c).toBe(1);
    expect(tables(bak)).toEqual(["portfolios", "transactions"]);
    bak.close();
    legacy.close();
  });

  it("rolls a failing migration back completely and leaves the version unchanged", () => {
    const db = new Database(":memory:");
    runMigrations(db, { migrations: MIGRATIONS.slice(0, 1) });
    const bad = [
      ...MIGRATIONS.slice(0, 1),
      { version: 2, name: "bad", sql: "CREATE TABLE half_done (x INTEGER); CREATE TABLE half_done (y INTEGER);" },
    ];
    expect(() => runMigrations(db, { migrations: bad })).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(tables(db)).not.toContain("half_done");
  });

  it("is safe when another process migrates between planning and applying (startup race)", () => {
    const file = join(dir, "race.db");
    const a = new Database(file);
    const b = new Database(file);
    // B plans to apply everything; before it does, A (the "other process") finishes the whole upgrade.
    const r = runMigrations(b, { _afterPlan: () => void runMigrations(a) });
    expect(r.applied).toEqual([]); // nothing left for B to do, and no "table already exists" crash
    expect(b.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect((b.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'watchlists'").get() as { c: number }).c).toBe(1);
    a.close();
    b.close();
  });

  it("applies a partially-upgraded database from where it left off", () => {
    const file = join(dir, "partial.db");
    const a = new Database(file);
    runMigrations(a, { migrations: MIGRATIONS.slice(0, 2) });
    const r = runMigrations(a);
    expect(r.from).toBe(2);
    expect(r.applied).toEqual(["3:events-alerts-signals-audit", "4:paper-trading-ai-reports"]);
    a.close();
  });

  it("refuses to open a database written by a newer build", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${LATEST_VERSION + 1}`);
    expect(() => runMigrations(db)).toThrow(/newer than this build/);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION + 1); // untouched
  });

  it("enforces key constraints added by the schema", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    expect(() => db.prepare("INSERT INTO paper_account (id, starting_cash, cash, created_at) VALUES (2, 1, 1, 1)").run()).toThrow();
    expect(() =>
      db.prepare("INSERT INTO signals (created_at,symbol,strategy,side,status,entry,stop,target,risk_per_share,reward_risk,valid_until,session_date,updated_at) VALUES (1,'A','orb','SHORT','pending',1,1,1,1,1,1,'d',1)").run()
    ).toThrow(); // long-only
    const ins = db.prepare("INSERT INTO signals (created_at,symbol,strategy,side,status,entry,stop,target,risk_per_share,reward_risk,valid_until,session_date,updated_at) VALUES (1,'A','orb','LONG','pending',1,1,1,1,1,1,'2026-11-02',1)");
    ins.run();
    expect(() => ins.run()).toThrow(); // one signal per strategy/symbol/session
  });
});
