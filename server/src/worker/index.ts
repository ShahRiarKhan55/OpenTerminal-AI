import { pathToFileURL } from "node:url";
import { ConfigError, loadWorkerConfig } from "../config.js";
import { createLogger, registerSecret } from "../log.js";
import { ClaudeProvider } from "../notify/ai.js";
import { createLiveSource } from "./liveSource.js";
import { createRuntime, type WorkerDeps } from "./runtime.js";
import { recoverOnStart, runLoop, type LoopControl } from "./loop.js";

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadWorkerConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`[worker] ${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  // Anything secret must be registered BEFORE the first log line is written.
  registerSecret(cfg.telegram.token);
  registerSecret(process.env.ANTHROPIC_API_KEY);
  registerSecret(process.env.API_KEY);
  const log = createLogger({ level: cfg.logLevel });

  // Imported here (not at module top) so a bad configuration is reported before the database is touched.
  const { db } = await import("../db.js");
  const integrity = db.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    log.error("database integrity check failed; refusing to start", { result: String(integrity).slice(0, 200) });
    process.exit(3);
  }

  const deps: WorkerDeps = {
    db,
    cfg,
    source: createLiveSource(),
    telegram: cfg.telegram.enabled ? { target: { token: cfg.telegram.token, chatId: cfg.telegram.chatId, apiBase: cfg.telegram.apiBase } } : null,
    ai: cfg.ai.enabled
      ? new ClaudeProvider(cfg.ai.model, { maxTokens: cfg.ai.maxTokens, timeoutMs: cfg.ai.timeoutMs, baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined, apiKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined })
      : null,
    now: Date.now,
    log,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  log.info("configuration", {
    tradingMode: cfg.tradingMode,
    pollSeconds: cfg.pollSeconds,
    maxSymbols: cfg.maxSymbols,
    telegram: Boolean(deps.telegram),
    ai: deps.ai ? { model: cfg.ai.model, dailyLimit: cfg.ai.dailyLimit } : false,
    freshness: cfg.freshness,
  });

  const rt = createRuntime(Date.now());
  const ctl: LoopControl = { stopped: false };
  const stop = (sig: string) => {
    if (ctl.stopped) return;
    log.info("shutdown requested", { signal: sig });
    ctl.stopped = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  const die = (why: string, err: unknown) => {
    log.error(why, { err: err instanceof Error ? err.message : String(err) });
    process.exit(1); // let the supervisor (Docker restart policy / systemd) bring up a clean process
  };
  process.on("uncaughtException", (e) => die("uncaught exception", e));
  process.on("unhandledRejection", (e) => die("unhandled rejection", e));

  recoverOnStart(deps, rt);
  await runLoop(deps, rt, ctl, { onFatal: (r) => die("fatal", new Error(r)) });

  log.info("worker stopped");
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {
    /* already closing */
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
