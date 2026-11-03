import Database from "better-sqlite3";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackup, listBackups, pruneBackups, restoreBackup } from "./backup.js";
import { LATEST_VERSION, MIGRATIONS, runMigrations } from "./migrations.js";
import { expectOwnerOnly, removeDir } from "./test-support.js";
import { workerHealth } from "./worker/healthcheck.js";

let dir: string;
let dbFile: string;
// Windows cannot delete a file that is still open. If a test fails half-way, its database handle (or the spawned writer) would
// otherwise stay open and make the directory cleanup fail with EPERM, so everything opened is tracked and released first.
const handles: Database.Database[] = [];
const children: ChildProcess[] = [];
const openDb = (file: string, opts?: Database.Options) => { const d = new Database(file, opts); handles.push(d); return d; };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ot-backup-"));
  dbFile = join(dir, "terminal.db");
});
afterEach(async () => {
  for (const c of children.splice(0)) {
    if (c.exitCode === null && c.signalCode === null) {
      const exited = new Promise((r) => c.once("exit", r));
      c.kill();
      await exited;
    }
  }
  for (const h of handles.splice(0)) {
    try { if (h.open) h.close(); } catch { /* already closed */ }
  }
  removeDir(dir);
});

function makeLive(rows = 5, wal = true): Database.Database {
  const db = openDb(dbFile);
  if (wal) db.pragma("journal_mode = WAL");
  runMigrations(db);
  db.prepare("INSERT INTO portfolios (name) VALUES ('Main')").run();
  const ins = db.prepare("INSERT INTO audit_log (ts, kind, decision, reason) VALUES (?, 'system', 'row', ?)");
  for (let i = 0; i < rows; i++) ins.run(i, `r${i}`);
  return db;
}
const count = (file: string, sql = "SELECT COUNT(*) c FROM audit_log") => {
  const d = openDb(file, { readonly: true });
  try { return (d.prepare(sql).get() as { c: number }).c; } finally { d.close(); }
};

describe("createBackup", () => {
  it("writes a verified, complete copy that includes data still sitting in the WAL", () => {
    const live = makeLive(25);
    // WAL mode keeps recent writes in terminal.db-wal; a naive file copy would miss them.
    expect(existsSync(dbFile + "-wal")).toBe(true);
    const r = createBackup({ dbFile, dir: join(dir, "backups"), now: Date.UTC(2026, 10, 2, 15, 30, 5) });
    expect(r.path).toMatch(/terminal-20261102T153005Z\.db$/);
    expect(r.userVersion).toBe(LATEST_VERSION);
    expect(count(r.path)).toBe(25);
    expect(count(r.path, "SELECT COUNT(*) c FROM portfolios")).toBe(1);
    expectOwnerOnly(join(dir, "backups")); // exact 0700 on POSIX; no broad ACL entry on Windows
    // the live database is untouched and still writable
    live.prepare("INSERT INTO audit_log (ts, kind, decision) VALUES (1, 'system', 'after')").run();
    expect(count(dbFile)).toBe(26);
    live.close();
  });

  it("is a snapshot: later writes do not leak into it", () => {
    const live = makeLive(3);
    const r = createBackup({ dbFile, dir: join(dir, "backups") });
    live.prepare("INSERT INTO audit_log (ts, kind, decision) VALUES (1, 'system', 'later')").run();
    expect(count(r.path)).toBe(3);
    live.close();
  });

  it("refuses to overwrite an existing backup and fails cleanly when the database is missing", () => {
    makeLive(1).close();
    const o = { dbFile, dir: join(dir, "backups"), now: 1_000_000_000_000 };
    createBackup(o);
    expect(() => createBackup(o)).toThrow(/already exists/);
    expect(() => createBackup({ dbFile: join(dir, "nope.db"), dir: join(dir, "backups") })).toThrow();
  });

  it("keeps only the newest N scheduled backups and never deletes safety copies", () => {
    makeLive(1).close();
    const bdir = join(dir, "backups");
    for (let i = 0; i < 6; i++) createBackup({ dbFile, dir: bdir, now: Date.UTC(2026, 0, 1 + i) });
    writeFileSync(join(bdir, "pre-migration-v2-2026.db"), "x");
    writeFileSync(join(bdir, "pre-restore-2026.db"), "x");
    const pruned = pruneBackups(bdir, 3);
    expect(pruned).toHaveLength(3);
    expect(listBackups(bdir)).toEqual(["terminal-20260104T000000Z.db", "terminal-20260105T000000Z.db", "terminal-20260106T000000Z.db"]);
    expect(readdirSync(bdir)).toEqual(expect.arrayContaining(["pre-migration-v2-2026.db", "pre-restore-2026.db"]));
    expect(pruneBackups(bdir, 3)).toEqual([]); // idempotent
    expect(pruneBackups(bdir, 0)).toHaveLength(2); // never prunes down to zero: always keeps the newest
    expect(listBackups(bdir)).toHaveLength(1);
  });

  it("stays consistent while ANOTHER PROCESS is writing to the database", async () => {
    makeLive(0).close();
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "test-child-writer.ts"), "4000", "w"], {
      env: { ...process.env, DATA_DIR: dir }, stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const done = new Promise<number | null>((r) => child.on("close", r));
    // Wait until the writer has really started writing (a fixed sleep is flaky when the machine is busy).
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      try {
        if (count(dbFile) > 20) break;
      } catch {
        /* database still being created */
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      results.push(createBackup({ dbFile, dir: join(dir, "backups"), now: Date.UTC(2026, 0, 1, 0, 0, i) }).path);
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(await done).toBe(0);
    let last = -1;
    for (const p of results) {
      const total = count(p);
      const m1 = count(p, "SELECT COUNT(*) c FROM audit_log WHERE decision = 'multi-1'");
      const m2 = count(p, "SELECT COUNT(*) c FROM audit_log WHERE decision = 'multi-2'");
      expect(m1, "multi-statement transactions must be all-or-nothing in a snapshot").toBe(m2);
      expect(total).toBeGreaterThanOrEqual(last);
      last = total;
      const d = openDb(p, { readonly: true });
      expect(d.pragma("integrity_check", { simple: true })).toBe("ok");
      d.close();
    }
    expect(last).toBeGreaterThan(0);
  }, 60_000);
});

describe("restoreBackup", () => {
  const backupOf = (rows: number) => {
    const live = makeLive(rows);
    const r = createBackup({ dbFile, dir: join(dir, "backups"), now: Date.UTC(2026, 5, rows) });
    live.close();
    return r.path;
  };

  it("refuses unless the operator confirms the services are stopped", () => {
    const b = backupOf(2);
    expect(() => restoreBackup({ dataDir: dir, backupFile: b, confirmedStopped: false })).toThrow(/stopped/);
    expect(count(dbFile)).toBe(2); // nothing changed
  });

  it("replaces the live database, keeps the old one aside, and drops stale WAL files", () => {
    const b = backupOf(3);
    const live = openDb(dbFile);
    live.pragma("journal_mode = WAL");
    for (let i = 0; i < 10; i++) live.prepare("INSERT INTO audit_log (ts, kind, decision) VALUES (1, 'system', 'extra')").run();
    live.close();
    expect(count(dbFile)).toBe(13);
    const r = restoreBackup({ dataDir: dir, backupFile: b, confirmedStopped: true, now: Date.UTC(2026, 10, 2, 16, 0, 0) });
    expect(count(dbFile)).toBe(3);
    expect(r.previousSavedAs).toMatch(/pre-restore-20261102T160000Z\.db$/);
    expect(count(r.previousSavedAs!)).toBe(13); // the replaced database is recoverable
    expect(existsSync(dbFile + "-wal")).toBe(false);
  });

  it("works when there is no live database yet (disaster recovery onto an empty volume)", () => {
    const b = backupOf(4);
    rmSync(dbFile);
    for (const e of ["-wal", "-shm"]) rmSync(dbFile + e, { force: true });
    const r = restoreBackup({ dataDir: dir, backupFile: b, confirmedStopped: true });
    expect(r.previousSavedAs).toBeNull();
    expect(count(dbFile)).toBe(4);
  });

  it.each([
    ["a missing file", (d: string) => join(d, "nope.db"), /not found/],
    ["a file that is not a database", (d: string) => { const f = join(d, "junk.db"); writeFileSync(f, "this is not sqlite at all, just text".repeat(20)); return f; }, /not a readable SQLite|corrupt|file is not a database/i],
    ["an unrelated SQLite database", (d: string) => { const f = join(d, "other.db"); const o = openDb(f); o.exec("CREATE TABLE x (a)"); o.close(); return f; }, /not an OpenTerminal backup/],
    ["a backup from a NEWER schema", (d: string) => { const f = join(d, "newer.db"); const o = openDb(f); runMigrations(o); o.pragma(`user_version = ${LATEST_VERSION + 5}`); o.close(); return f; }, /newer version/],
  ])("rejects %s and changes nothing", (_n, make, msg) => {
    makeLive(7).close();
    const bad = make(dir);
    expect(() => restoreBackup({ dataDir: dir, backupFile: bad, confirmedStopped: true })).toThrow(msg);
    expect(count(dbFile)).toBe(7);
    expect(existsSync(join(dir, "backups"))).toBe(false);
  });

  it("an OLDER backup restores and is then upgraded by the normal migrations", () => {
    const old = join(dir, "v2.db");
    const o = openDb(old);
    runMigrations(o, { migrations: MIGRATIONS.slice(0, 2) });
    o.prepare("INSERT INTO portfolios (name) VALUES ('Main')").run();
    o.close();
    restoreBackup({ dataDir: dir, backupFile: old, confirmedStopped: true });
    const d = openDb(dbFile);
    expect(d.pragma("user_version", { simple: true })).toBe(2);
    runMigrations(d);
    expect(d.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    expect((d.prepare("SELECT COUNT(*) c FROM portfolios").get() as { c: number }).c).toBe(1);
    d.close();
  });
});

describe("command-line scripts", () => {
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "scripts", script), ...args], { env: { ...process.env, DATA_DIR: dir, ...env }, encoding: "utf8" });

  it("backup.js creates a backup, honours --keep, and rejects bad arguments", () => {
    makeLive(2).close();
    const a = run("backup.ts", ["--keep", "2"]);
    expect(a.status).toBe(0);
    expect(a.stdout).toMatch(/backup ok: .*terminal-\d{8}T\d{6}Z\.db/);
    expect(listBackups(join(dir, "backups")).length).toBe(1);
    expect(run("backup.ts", ["--keep", "0"]).status).toBe(2);
    expect(run("backup.ts", ["--keep", "abc"]).status).toBe(2);
    expect(run("backup.ts", [], { DATA_DIR: join(dir, "missing") }).status).toBe(1);
  }, 30_000);

  it("restore.js demands --confirm-stopped and a file", () => {
    const live = makeLive(2);
    const b = createBackup({ dbFile, dir: join(dir, "backups") }).path;
    live.close();
    expect(run("restore.ts", []).status).toBe(2);
    expect(run("restore.ts", [b]).status).toBe(1);
    expect(run("restore.ts", [b, "--confirm-stopped"]).status).toBe(0);
  }, 30_000);
});

describe("workerHealth", () => {
  const setHeartbeat = (value: unknown) => {
    const d = openDb(dbFile);
    runMigrations(d);
    d.prepare("INSERT OR REPLACE INTO worker_state (key, value, updated_at) VALUES ('heartbeat', ?, 0)").run(typeof value === "string" ? value : JSON.stringify(value));
    d.close();
  };
  const now = 1_800_000_000_000;
  it("is unhealthy with no database, no heartbeat, or a malformed one", () => {
    expect(workerHealth(dbFile, now, 900).ok).toBe(false);
    const d = openDb(dbFile); runMigrations(d); d.close();
    expect(workerHealth(dbFile, now, 900)).toMatchObject({ ok: false, reason: "no heartbeat yet" });
    setHeartbeat({ tickAt: "yesterday" });
    expect(workerHealth(dbFile, now, 900).reason).toBe("malformed heartbeat");
    setHeartbeat("{not json");
    expect(workerHealth(dbFile, now, 900).ok).toBe(false);
  });
  it("is healthy iff a cycle completed within the limit", () => {
    setHeartbeat({ tickAt: now - 60_000 });
    expect(workerHealth(dbFile, now, 900)).toEqual({ ok: true, reason: "last cycle 60s ago" });
    setHeartbeat({ tickAt: now - 901_000 });
    expect(workerHealth(dbFile, now, 900).ok).toBe(false);
    expect(workerHealth(dbFile, now, 1000).ok).toBe(true);
  });
  it("never modifies the database it inspects", () => {
    setHeartbeat({ tickAt: now });
    const before = statSync(dbFile).mtimeMs;
    workerHealth(dbFile, now, 900);
    expect(statSync(dbFile).mtimeMs).toBe(before);
  });
  void mkdirSync;
});
