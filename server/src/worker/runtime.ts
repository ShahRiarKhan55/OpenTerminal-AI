import type Database from "better-sqlite3";
import type { WorkerConfig } from "../config.js";
import type { Bar } from "../engine/types.js";
import type { CalendarEvent } from "../engine/marketEvents.js";
import type { Logger } from "../log.js";
import type { AnalysisProvider } from "../notify/ai.js";
import type { FetchLike, TelegramTarget } from "../notify/telegram.js";
import type { Quote } from "../providers/yahoo.js";

export type Headline = { title: string; publisher: string; publishedAt: string | null };

/** Everything the worker needs from the outside world. Swapped for fakes in tests. */
export type DataSource = {
  quotes(symbols: string[]): Promise<Quote[]>;
  /** Today's (and recent) 5-minute bars, epoch-second bar starts in UTC. */
  intradayBars(symbol: string): Promise<Bar[]>;
  dailyBars(symbol: string): Promise<Bar[]>;
  economicEvents(): Promise<CalendarEvent[]>;
  headlines(symbol: string): Promise<Headline[]>;
};

export type WorkerDeps = {
  db: Database.Database;
  cfg: WorkerConfig;
  source: DataSource;
  telegram: { target: TelegramTarget; fetchImpl?: FetchLike } | null;
  ai: AnalysisProvider | null;
  now: () => number;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
};

type CacheEntry<T> = { value: T; fetchedAt: number };

/** In-memory, per-process state. Anything that must survive a restart lives in SQLite instead. */
export type Runtime = {
  startedAt: number;
  tickCount: number;
  errorCount: number;
  lastError: string | null;
  quoteFailures: number;
  intraday: Map<string, CacheEntry<Bar[]>>;
  daily: Map<string, CacheEntry<Bar[]>>;
  econ: CacheEntry<CalendarEvent[]> | null;
  newsCursor: number;
  lastNewsAt: number;
  /** key -> last time an operational (non-alert) message was audited, to keep the audit log readable */
  gates: Map<string, number>;
  lastMaintenanceDate: string | null;
};

export function createRuntime(now: number): Runtime {
  return {
    startedAt: now,
    tickCount: 0,
    errorCount: 0,
    lastError: null,
    quoteFailures: 0,
    intraday: new Map(),
    daily: new Map(),
    econ: null,
    newsCursor: 0,
    lastNewsAt: 0,
    gates: new Map(),
    lastMaintenanceDate: null,
  };
}

/** True at most once per `everyMs` for a key. Used to rate-limit repetitive audit/log lines. */
export function gate(rt: Runtime, key: string, everyMs: number, nowMs: number): boolean {
  const last = rt.gates.get(key);
  if (last !== undefined && nowMs - last < everyMs) return false;
  rt.gates.set(key, nowMs);
  if (rt.gates.size > 5000) {
    for (const [k, t] of rt.gates) if (nowMs - t > 86_400_000) rt.gates.delete(k);
  }
  return true;
}

/** Symbols always polled for the market-conditions panel (not counted against the watchlist cap). */
export const BENCHMARKS = ["SPY", "QQQ", "IWM", "^VIX"] as const;
