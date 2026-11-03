// Real-process smoke test of the compiled worker: starts, writes a heartbeat, refuses live mode,
// and exits 0 promptly on SIGTERM. Works offline: provider failures are tolerated by design.
const { spawn, spawnSync } = require("child_process");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const Database = require(join(__dirname, "..", "node_modules", "better-sqlite3"));
const worker = join(__dirname, "..", "server", "dist", "worker", "index.js");
const results = [];
const check = (n, ok, x = "") => { results.push(ok); console.log((ok ? "PASS " : "FAIL ") + n + (x ? "  -> " + x : "")); };

const dir = mkdtempSync(join(tmpdir(), "ot-wsmoke-"));
const env = { ...process.env, DATA_DIR: dir, MONITOR_POLL_SECONDS: "15", MONITOR_NEWS_ENABLED: "false", LOG_LEVEL: "info" };

const live = spawnSync(process.execPath, [worker], { env: { ...env, TRADING_MODE: "live" }, encoding: "utf8" });
check("refuses TRADING_MODE=live (exit 2)", live.status === 2 && /only 'paper'/.test(live.stderr), `exit ${live.status}`);
const bad = spawnSync(process.execPath, [worker], { env: { ...env, MONITOR_POLL_SECONDS: "1", TELEGRAM_BOT_TOKEN: "SECRETVALUE-not-a-token" }, encoding: "utf8" });
check("reports every config problem without echoing values", bad.status === 2 && !/SECRETVALUE/.test(bad.stderr) && /MONITOR_POLL_SECONDS/.test(bad.stderr));

const child = spawn(process.execPath, [worker], { env, stdio: ["ignore", "pipe", "pipe"] });
let out = "", err = "";
child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch {} await new Promise((r) => setTimeout(r, 500)); } return false; };
(async () => {
  const beat = await waitFor(() => {
    const db = new Database(join(dir, "terminal.db"), { readonly: true });
    try { return db.prepare("SELECT value FROM worker_state WHERE key='heartbeat'").get(); } finally { db.close(); }
  }, 90_000);
  check("writes a heartbeat within 90 s", beat);
  const db = new Database(join(dir, "terminal.db"), { readonly: true });
  const hb = beat ? JSON.parse(db.prepare("SELECT value FROM worker_state WHERE key='heartbeat'").get().value) : {};
  check("heartbeat says paper mode", hb.tradingMode === "paper");
  const { LATEST_VERSION } = await import(require("url").pathToFileURL(join(__dirname, "..", "server", "dist", "migrations.js")).href);
  check("database is at the current schema and intact", db.pragma("user_version", { simple: true }) === LATEST_VERSION && db.pragma("integrity_check", { simple: true }) === "ok", `v${LATEST_VERSION}`);
  db.close();
  const t0 = Date.now(); child.kill("SIGTERM");
  const code = await new Promise((r) => child.on("close", r));
  check("exits 0 within 5 s of SIGTERM", code === 0 && Date.now() - t0 < 5000, `exit ${code} in ${Date.now() - t0} ms`);
  check("no errors on stderr", err.replace(/\(node:\d+\)[^\n]*\n?|\(Use `node[^\n]*\n?/g, "").trim() === "", err.slice(0, 120));
  check("logs contain no secrets", !/sk-ant|bot\d+:/.test(out + err));
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
