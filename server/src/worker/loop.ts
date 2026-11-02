import { audit } from "../audit.js";
import { listOpenPositions } from "../engine/paper.js";
import { getWorkerState, pendingSignals } from "../engine/store.js";
import { etClock } from "../marketdata/time.js";
import { raiseAlert } from "../notify/alerts.js";
import { createRuntime, type Runtime, type WorkerDeps } from "./runtime.js";
import { runTick, type TickSummary } from "./tick.js";

export type LoopControl = { stopped: boolean };

export type LoopOptions = {
  /** A tick that runs longer than this is declared hung. All network calls have their own shorter timeouts. */
  tickTimeoutMs?: number;
  /** Called when a hung tick still hasn't settled after a further grace period: let the supervisor restart us. */
  onFatal?: (reason: string) => void;
  /** Random source for poll jitter (injectable for tests). */
  random?: () => number;
};

const MAX_BACKOFF_SECONDS = 300;

/** Poll fast during (and just around) the regular session, slowly otherwise. */
export function pollDelaySeconds(deps: Pick<WorkerDeps, "cfg">, nowMs: number, consecutiveFailures: number): number {
  const c = etClock(nowMs);
  const inSession = c.isWeekday && c.minutes >= 9 * 60 + 15 && c.minutes <= 16 * 60 + 30;
  const base = inSession ? deps.cfg.pollSeconds : deps.cfg.idlePollSeconds;
  if (consecutiveFailures <= 0) return base;
  // Exponential backoff after failed ticks, capped, so an outage doesn't turn into a retry storm.
  return Math.min(MAX_BACKOFF_SECONDS, base * 2 ** Math.min(consecutiveFailures, 6));
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then((value) => ({ timedOut: false as const, value })), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Called once at startup. All durable state (positions, pending signals, de-dupe history, AI budget,
 * Telegram outbox) is in SQLite, so recovery means: note the gap, retire what expired while we were
 * down, and tell the user if paper positions were left open across the outage.
 */
export function recoverOnStart(deps: WorkerDeps, rt: Runtime): { openPositions: number; pendingSignals: number; downSeconds: number | null } {
  const { db, cfg, log } = deps;
  const now = deps.now();
  const prev = getWorkerState<{ tickAt: number }>(db, "heartbeat");
  const downSeconds = prev ? Math.max(0, Math.round((now - prev.value.tickAt) / 1000)) : null;
  const open = listOpenPositions(db).length;
  const pending = pendingSignals(db).length;
  audit(db, { kind: "system", decision: "worker_started", detail: { pid: process.pid, downSeconds, openPositions: open, pendingSignals: pending, tradingMode: cfg.tradingMode } }, now);
  log.info("worker started", { downSeconds, openPositions: open, pendingSignals: pending, tradingMode: cfg.tradingMode });
  if (open > 0 && downSeconds !== null && downSeconds > 300) {
    raiseAlert(
      { db, nowMs: now, cfg },
      {
        type: "worker_restarted",
        symbol: null,
        importance: "high",
        dedupeKey: `restart:${rt.startedAt}`,
        cooldownMs: 3_600_000,
        title: "Monitor restarted with open paper positions",
        body: `The worker was down for about ${Math.round(downSeconds / 60)} minutes with ${open} open paper position(s). Stops and targets were not evaluated during the gap; they are being checked now.`,
      }
    );
  }
  return { openPositions: open, pendingSignals: pending, downSeconds };
}

/**
 * The main loop. Guarantees: ticks never overlap; one failing tick never stops the loop; failures back
 * off exponentially; a hung tick is detected; stopping is prompt (sleeps are sliced) and graceful.
 */
export async function runLoop(deps: WorkerDeps, rt: Runtime, ctl: LoopControl, opts: LoopOptions = {}): Promise<void> {
  const tickTimeoutMs = opts.tickTimeoutMs ?? 120_000;
  const random = opts.random ?? Math.random;
  let failures = 0;

  while (!ctl.stopped) {
    const tick = runTick(deps, rt);
    let summary: TickSummary | null = null;
    try {
      const r = await withTimeout(tick, tickTimeoutMs);
      if (r.timedOut) {
        failures++;
        deps.log.error("tick exceeded its time limit", { tickTimeoutMs });
        audit(deps.db, { kind: "system", decision: "tick_timeout", detail: { tickTimeoutMs } }, deps.now());
        // Never start a second tick while the first is still running; give it one more window, then restart.
        const grace = await withTimeout(tick.catch(() => undefined), tickTimeoutMs);
        if (grace.timedOut) {
          opts.onFatal?.("tick hung beyond grace period");
          return;
        }
      } else {
        summary = r.value;
        failures = summary.errors.length > 0 && summary.quotes === 0 ? failures + 1 : 0;
      }
    } catch (err) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      rt.errorCount++;
      rt.lastError = `tick: ${msg}`;
      deps.log.error("tick failed", { err: msg });
    }
    if (summary) deps.log.debug("tick", { ...summary });
    if (ctl.stopped) break;

    const waitMs = pollDelaySeconds(deps, deps.now(), failures) * 1000 * (1 + (random() - 0.5) * 0.2);
    let waited = 0;
    while (waited < waitMs && !ctl.stopped) {
      const slice = Math.min(1000, waitMs - waited);
      await deps.sleep(slice);
      waited += slice;
    }
  }
}

export { createRuntime };
