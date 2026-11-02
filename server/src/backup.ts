import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LATEST_VERSION } from "./migrations.js";

/**
 * Backup and restore for the SQLite database. Backups use `VACUUM INTO`, which produces a transactionally
 * consistent copy WHILE the API and the worker keep running (no downtime, no torn files): never copy
 * terminal.db with cp/rsync while it is in use, because WAL mode keeps recent writes in a separate file.
 */

const NAME_RE = /^terminal-(\d{8}T\d{6}Z)\.db$/;

export type BackupResult = { path: string; bytes: number; userVersion: number; pruned: string[] };

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function listBackups(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => NAME_RE.test(f)).sort(); // timestamp in the name sorts chronologically
}

/** Delete all but the newest `keep` scheduled backups. Pre-migration and pre-restore safety copies are never touched. */
export function pruneBackups(dir: string, keep: number): string[] {
  const all = listBackups(dir);
  const doomed = keep >= all.length ? [] : all.slice(0, all.length - Math.max(1, keep));
  for (const f of doomed) rmSync(join(dir, f), { force: true });
  return doomed;
}

export function createBackup(opts: { dbFile: string; dir: string; keep?: number; now?: number }): BackupResult {
  const now = opts.now ?? Date.now();
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
  const target = join(opts.dir, `terminal-${stamp(now)}.db`);
  if (existsSync(target)) throw new Error(`backup already exists: ${target}`);
  const src = new Database(opts.dbFile, { readonly: true, fileMustExist: true });
  try {
    src.prepare("VACUUM INTO ?").run(target);
  } finally {
    src.close();
  }
  // Never trust a backup you have not opened: verify it independently of the source.
  const check = new Database(target, { readonly: true, fileMustExist: true });
  try {
    const integrity = check.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") {
      rmSync(target, { force: true });
      throw new Error(`backup failed its integrity check: ${String(integrity).slice(0, 200)}`);
    }
    const userVersion = check.pragma("user_version", { simple: true }) as number;
    const pruned = opts.keep !== undefined ? pruneBackups(opts.dir, opts.keep) : [];
    return { path: target, bytes: statSync(target).size, userVersion, pruned };
  } finally {
    check.close();
  }
}

export type RestoreResult = { restoredFrom: string; previousSavedAs: string | null; userVersion: number };

/**
 * Replace the live database with a backup. The caller must have stopped every process that uses the
 * database (restore checks what it can, but cannot see other processes). The current database is
 * never deleted: it is moved aside so a mistaken restore can itself be undone.
 */
export function restoreBackup(opts: { dataDir: string; backupFile: string; confirmedStopped: boolean; now?: number }): RestoreResult {
  if (!opts.confirmedStopped) throw new Error("refusing to restore: confirm that the API and worker are stopped (--confirm-stopped)");
  if (!existsSync(opts.backupFile)) throw new Error(`backup not found: ${opts.backupFile}`);

  const probe = (() => {
    try {
      return new Database(opts.backupFile, { readonly: true, fileMustExist: true });
    } catch (e) {
      throw new Error(`not a readable SQLite database: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  let userVersion: number;
  try {
    const integrity = probe.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`backup is corrupt: ${String(integrity).slice(0, 200)}`);
    userVersion = probe.pragma("user_version", { simple: true }) as number;
    if (userVersion > LATEST_VERSION) throw new Error(`backup is from a newer version (schema v${userVersion} > v${LATEST_VERSION}); upgrade the application first`);
    if (!probe.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'portfolios'").get()) throw new Error("file is a SQLite database but not an OpenTerminal backup");
  } finally {
    probe.close();
  }

  const live = join(opts.dataDir, "terminal.db");
  const ts = stamp(opts.now ?? Date.now());
  let previousSavedAs: string | null = null;
  if (existsSync(live)) {
    previousSavedAs = join(opts.dataDir, "backups", `pre-restore-${ts}.db`);
    mkdirSync(join(opts.dataDir, "backups"), { recursive: true, mode: 0o700 });
    renameSync(live, previousSavedAs);
  }
  // A stale WAL/SHM from the previous database must not be replayed onto the restored one.
  for (const ext of ["-wal", "-shm"]) {
    const side = live + ext;
    if (existsSync(side)) renameSync(side, join(opts.dataDir, "backups", `pre-restore-${ts}.db${ext}`));
  }
  copyFileSync(opts.backupFile, live);

  const after = new Database(live, { readonly: true, fileMustExist: true });
  try {
    if (after.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("restored database failed its integrity check");
  } finally {
    after.close();
  }
  return { restoredFrom: opts.backupFile, previousSavedAs, userVersion };
}
