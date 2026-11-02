import type Database from "better-sqlite3";

export type AuditEntry = {
  kind: "signal" | "risk" | "order" | "alert" | "ai" | "notify" | "data" | "system" | "config" | "api";
  symbol?: string | null;
  decision: string;
  reason?: string | null;
  detail?: unknown;
};

const MAX_DETAIL = 4000;

/** Append-only record of every automated decision. Never throws: auditing must not break trading logic. */
export function audit(db: Database.Database, e: AuditEntry, nowMs: number): void {
  try {
    let detail: string | null = null;
    if (e.detail !== undefined) {
      detail = JSON.stringify(e.detail) ?? null;
      if (detail && detail.length > MAX_DETAIL) detail = detail.slice(0, MAX_DETAIL) + '…"truncated"';
    }
    db.prepare("INSERT INTO audit_log (ts, kind, symbol, decision, reason, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
      nowMs, e.kind, e.symbol ?? null, e.decision, e.reason ?? null, detail
    );
  } catch (err) {
    // Last resort: a failing audit write must never take the worker down.
    console.error("[audit] write failed:", err instanceof Error ? err.message : String(err));
  }
}

export type AuditRow = { id: number; ts: number; kind: string; symbol: string | null; decision: string; reason: string | null; detail: string | null };

export function listAudit(db: Database.Database, opts: { limit: number; kind?: string; symbol?: string; beforeId?: number }): AuditRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
  if (opts.symbol) { where.push("symbol = ?"); args.push(opts.symbol); }
  if (opts.beforeId) { where.push("id < ?"); args.push(opts.beforeId); }
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, opts.limit) as AuditRow[];
}

/** Retention: delete old operational history. Reports and the paper ledger are kept. */
export function pruneOldData(db: Database.Database, retentionDays: number, nowMs: number): { audit: number; events: number; alerts: number; aiCalls: number } {
  const cutoff = nowMs - retentionDays * 86_400_000;
  const run = (sql: string, ...a: number[]) => db.prepare(sql).run(...a).changes;
  return {
    audit: run("DELETE FROM audit_log WHERE ts < ?", cutoff),
    alerts: run("DELETE FROM alerts WHERE created_at < ?", cutoff),
    events: run("DELETE FROM events WHERE created_at < ?", cutoff),
    aiCalls: run("DELETE FROM ai_calls WHERE ts < ?", Math.min(cutoff, nowMs - 35 * 86_400_000)),
  };
}
