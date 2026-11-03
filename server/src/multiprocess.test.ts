import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LATEST_VERSION } from "./migrations.js";

/**
 * The API and the monitor are separate OS processes sharing one SQLite file. This runs the real thing:
 * two processes importing the real db module at the SAME moment on a brand-new directory (racing on
 * first-time migrations and seeds) and then writing concurrently.
 */
const dir = mkdtempSync(join(tmpdir(), "ot-mp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runChild(n: number, tag: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "test-child-writer.ts"), String(n), tag], {
      env: { ...process.env, DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

describe("two processes sharing one database", () => {
  it("both start on a fresh directory, race the migrations safely, and lose no writes under contention", async () => {
    const N = 1500;
    const child = runChild(N, "child"); // start the other process FIRST
    process.env.DATA_DIR = dir;
    const { db } = await import("./db.js"); // ...and race it on migrations and seeds
    const ins = db.prepare("INSERT INTO audit_log (ts, kind, decision, reason) VALUES (?, 'system', ?, ?)");
    const tx = db.transaction((i: number) => {
      ins.run(Date.now(), "multi-1", `parent:${i}`);
      ins.run(Date.now(), "multi-2", `parent:${i}`);
    });
    for (let i = 0; i < N; i++) {
      if (i % 3 === 0) tx.immediate(i);
      else ins.run(Date.now(), "single", `parent:${i}`);
    }
    const r = await child;

    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`done ${N}`);

    const per = (tag: string) => (db.prepare("SELECT COUNT(*) c FROM audit_log WHERE reason LIKE ?").get(`${tag}:%`) as { c: number }).c;
    const expected = N + Math.ceil(N / 3); // one extra row per multi-statement transaction
    expect(per("parent")).toBe(expected);
    expect(per("child")).toBe(expected);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    // WAL is what lets the API read while the worker writes (readers never block on the writer).
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_VERSION);
    // seeds were applied exactly once despite the race
    expect((db.prepare("SELECT COUNT(*) c FROM watchlists WHERE name = 'Default'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM paper_account").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM portfolios WHERE name = 'Main'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM watchlist_items").get() as { c: number }).c).toBe(8);
    db.close();
  }, 120_000);
});
