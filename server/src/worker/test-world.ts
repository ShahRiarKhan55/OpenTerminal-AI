import type Database from "better-sqlite3";
import { loadWorkerConfig, type WorkerConfig } from "../config.js";
import type { Bar } from "../engine/types.js";
import { silentLogger } from "../log.js";
import { easternToEpochMs } from "../marketdata/time.js";
import type { AnalysisProvider, AnalysisRequest } from "../notify/ai.js";
import type { Quote } from "../providers/yahoo.js";
import { makeDb } from "../test-helpers.js";
import { createRuntime, type DataSource, type Headline, type Runtime, type WorkerDeps } from "./runtime.js";
import { runTick, type TickSummary } from "./tick.js";
import type { CalendarEvent } from "../engine/marketEvents.js";

/** Test harness: a scripted market, a controllable clock, and capturing fakes for Telegram and the AI. */
export const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
export const DAY = [2026, 6, 15] as const; // Wednesday, EDT (UTC-4)
export const at = (h: number, m: number, s = 0, day = 0) => easternToEpochMs(DAY[0], DAY[1], DAY[2] + day, h, m)! + s * 1000;

export type QuoteSpec = Partial<Quote> & { price: number };

export class World {
  db: Database.Database;
  t = at(9, 0);
  quotes = new Map<string, QuoteSpec>();
  intraday = new Map<string, Bar[]>();
  daily = new Map<string, Bar[]>();
  headlines = new Map<string, Headline[]>();
  econ: CalendarEvent[] = [];
  quoteError: Error | null = null;
  telegramSent: string[] = [];
  telegramStatus = 200;
  aiCalls: AnalysisRequest[] = [];
  aiFail = false;
  cfg: WorkerConfig;
  rt: Runtime;
  deps: WorkerDeps;
  fetchCounts = { quotes: 0, intraday: 0, daily: 0 };

  constructor(opts: { symbols?: string[]; env?: NodeJS.ProcessEnv; telegram?: boolean; ai?: boolean } = {}) {
    this.db = makeDb();
    const symbols = opts.symbols ?? ["ABC"];
    const id = Number(this.db.prepare("INSERT INTO watchlists (name) VALUES ('Default')").run().lastInsertRowid);
    symbols.forEach((s, i) => this.db.prepare("INSERT INTO watchlist_items (watchlist_id, symbol, position) VALUES (?, ?, ?)").run(id, s, i));
    this.cfg = loadWorkerConfig({
      ...(opts.telegram === false ? {} : { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42" }),
      ...(opts.ai === false ? {} : { ANTHROPIC_API_KEY: "sk-ant-test" }),
      AI_MIN_INTERVAL_SEC: "0",
      MONITOR_NEWS_ENABLED: "false",
      MONITOR_MAX_SYMBOLS: "20",
      ...opts.env,
    });
    for (const b of ["SPY", "QQQ", "IWM"]) this.setPrice(b, 500, { changePercent: 0.4 });
    this.setPrice("^VIX", 15, { source: "fred", delayClass: "eod", marketState: null, time: null });
    for (const s of symbols) {
      this.setPrice(s, 100);
      this.daily.set(s, quietDaily());
      this.intraday.set(s, []);
    }
    const self = this;
    const source: DataSource = {
      async quotes(syms) {
        self.fetchCounts.quotes++;
        if (self.quoteError) throw self.quoteError;
        return syms.filter((s) => self.quotes.has(s)).map((s) => self.makeQuote(s));
      },
      async intradayBars(s) {
        self.fetchCounts.intraday++;
        return self.intraday.get(s) ?? [];
      },
      async dailyBars(s) {
        self.fetchCounts.daily++;
        return self.daily.get(s) ?? [];
      },
      async economicEvents() {
        return self.econ;
      },
      async headlines(s) {
        return self.headlines.get(s) ?? [];
      },
    };
    const ai: AnalysisProvider = {
      name: "fake",
      model: "fake-model",
      async analyze(req) {
        self.aiCalls.push(req);
        if (self.aiFail) throw new Error("ai down");
        return { text: `Analysis for ${req.symbol}`, inputTokens: 10, outputTokens: 5 };
      },
    };
    this.deps = {
      db: this.db,
      cfg: this.cfg,
      source,
      telegram:
        opts.telegram === false
          ? null
          : {
              target: { token: TOKEN, chatId: "42", apiBase: "http://telegram.invalid" },
              fetchImpl: async (_url, init) => {
                if (self.telegramStatus === 200) self.telegramSent.push(JSON.parse(String(init.body)).text);
                return new Response(JSON.stringify({ ok: self.telegramStatus === 200, description: "x" }), { status: self.telegramStatus });
              },
            },
      ai: opts.ai === false ? null : ai,
      now: () => self.t,
      log: silentLogger,
      sleep: async () => {},
    };
    this.rt = createRuntime(this.t);
  }

  setPrice(symbol: string, price: number, extra: Partial<Quote> = {}) {
    this.quotes.set(symbol, { ...(this.quotes.get(symbol) ?? {}), price, ...extra } as QuoteSpec);
  }

  /** Every instrument (benchmarks included) reports a closed market, like a holiday. */
  closeMarket() {
    for (const [sym, q] of this.quotes) this.quotes.set(sym, { ...q, marketState: "Market Closed" });
  }

  makeQuote(symbol: string): Quote {
    const s = this.quotes.get(symbol)!;
    const t = this.t;
    return {
      symbol, name: symbol, change: null, changePercent: 0.2, open: null, high: null, low: null, previousClose: null,
      bid: null, ask: null, volume: null, avgVolume: 2_000_000, marketCap: null, pe: null, eps: null, dividendYield: null,
      week52High: 500, week52Low: 50, beta: null, sharesOutstanding: null, currency: "USD", exchange: "NASDAQ",
      marketState: "Market Open", time: Math.floor(t / 1000) - 2, source: "nasdaq", delayClass: "realtime", fetchedAt: t - 1000,
      ...s,
    } as unknown as Quote;
  }

  /** Advance the clock to ET h:m:s and run one real tick. */
  async tick(h: number, m: number, s = 0, day = 0): Promise<TickSummary> {
    this.t = at(h, m, s, day);
    return runTick(this.deps, this.rt);
  }

  /** Restart the process: new in-memory runtime, same database. */
  restart() {
    this.rt = createRuntime(this.t);
  }

  one<T = Record<string, unknown>>(sql: string, ...a: unknown[]): T {
    return this.db.prepare(sql).get(...a) as T;
  }
  all<T = Record<string, unknown>>(sql: string, ...a: unknown[]): T[] {
    return this.db.prepare(sql).all(...a) as T[];
  }
  count(table: string, where = "1=1", ...a: unknown[]): number {
    return (this.db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${where}`).get(...a) as { c: number }).c;
  }
  alertTypes(): string[] {
    return this.all<{ type: string }>("SELECT type FROM alerts ORDER BY id").map((r) => r.type);
  }
}

/** 60 completed daily bars with mild zig-zag, so RSI is moderate and no breakout/extreme fires by accident. */
export function quietDaily(base = 100): Bar[] {
  const out: Bar[] = [];
  for (let i = 60; i >= 1; i--) {
    const close = base + (60 - i) * 0.05 + (i % 2 ? 0.3 : -0.3);
    out.push({ time: Date.UTC(DAY[0], DAY[1], DAY[2] - i) / 1000, open: close - 0.1, high: close + 0.5, low: close - 0.5, close, volume: 3_000_000 });
  }
  return out;
}

const bar = (h: number, m: number, o: number, hi: number, lo: number, c: number, v: number): Bar => ({ time: at(h, m) / 1000, open: o, high: hi, low: lo, close: c, volume: v });

/** Opening range 100.0-101.0 (09:30-09:55), then a breakout bar closing above it at 10:00. */
export function orbBars(scale = 1, withBreakout = true): Bar[] {
  const closes = [100.4, 100.6, 100.5, 100.7, 100.6, 100.8];
  const out = closes.map((c, i) => {
    const mins = 30 + i * 5;
    return bar(9 + Math.floor(mins / 60), mins % 60, c * scale, (i === 3 ? 101.0 : 100.9) * scale, (i === 1 ? 100.0 : 100.2) * scale, c * scale, 1000);
  });
  if (withBreakout) out.push(bar(10, 0, 100.8 * scale, 101.4 * scale, 100.8 * scale, 101.3 * scale, 1800));
  return out;
}
