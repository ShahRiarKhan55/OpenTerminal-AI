import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Container health check for the worker: healthy iff a monitoring cycle completed recently.
 * Opens the database READ-ONLY (it must never migrate or seed). The threshold covers the slow
 * off-hours poll interval; override with HEALTH_MAX_AGE_SEC.
 */
export function workerHealth(dbFile: string, nowMs: number, maxAgeSec: number): { ok: boolean; reason: string } {
  if (!existsSync(dbFile)) return { ok: false, reason: "database not found" };
  let db: Database.Database;
  try {
    db = new Database(dbFile, { readonly: true, fileMustExist: true });
  } catch (e) {
    return { ok: false, reason: `cannot open database: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const row = db.prepare("SELECT value FROM worker_state WHERE key = 'heartbeat'").get() as { value: string } | undefined;
    if (!row) return { ok: false, reason: "no heartbeat yet" };
    const hb = JSON.parse(row.value) as { tickAt?: unknown };
    if (typeof hb.tickAt !== "number") return { ok: false, reason: "malformed heartbeat" };
    const age = Math.round((nowMs - hb.tickAt) / 1000);
    return age <= maxAgeSec ? { ok: true, reason: `last cycle ${age}s ago` } : { ok: false, reason: `last cycle ${age}s ago (limit ${maxAgeSec}s)` };
  } catch (e) {
    return { ok: false, reason: `unreadable heartbeat: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const max = Number(process.env.HEALTH_MAX_AGE_SEC || 900);
  const r = workerHealth(join(process.env.DATA_DIR || "./data", "terminal.db"), Date.now(), Number.isFinite(max) && max > 0 ? max : 900);
  console.log(r.ok ? `healthy: ${r.reason}` : `UNHEALTHY: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
