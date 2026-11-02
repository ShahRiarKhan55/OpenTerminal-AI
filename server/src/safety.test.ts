import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config.js";

/**
 * Static guardrails for "real-money execution is impossible". These scan the
 * production source tree, so adding broker code (even by accident, even in a
 * rarely-run branch) fails CI.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith("test-helpers.ts")) out.push(p);
  }
  return out;
}
const ROOT = join(import.meta.dirname, ".");
const FILES = sourceFiles(ROOT).map((p) => ({ path: p.slice(ROOT.length + 1), text: readFileSync(p, "utf8") }));

describe("no brokerage execution exists in the codebase", () => {
  it("finds a realistic number of source files (guards against scanning nothing)", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  const BROKER_HOSTS = [
    "alpaca.markets", "interactivebrokers", "ibkr", "tradier", "tdameritrade", "schwab", "robinhood", "etrade", "webull",
    "tradestation", "oanda", "fidelity", "tastytrade", "tastyworks", "degiro", "trading212", "saxo", "ig.com",
  ];
  it.each(BROKER_HOSTS)("never references the brokerage host/vendor %s", (host) => {
    const hits = FILES.filter((f) => f.text.toLowerCase().includes(host)).map((f) => f.path);
    expect(hits).toEqual([]);
  });

  const ORDER_APIS = [/place[_-]?order/i, /submit[_-]?order/i, /create[_-]?order/i, /new[_-]?order/i, /\/v3\/order/i, /mcp__alpaca/i, /place_stock_order/i, /cancel_all_orders/i];
  it.each(ORDER_APIS.map((r) => [String(r), r] as const))("has no order-placement API call matching %s", (_n, re) => {
    expect(FILES.filter((f) => re.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("keeps the paper ledger free of any network or process capability", () => {
    const ledger = FILES.find((f) => f.path === join("engine", "paper.ts"))!;
    for (const forbidden of [/\bfetch\(/, /httpFetch/, /from "node:(http|https|net|child_process|dgram|tls)"/, /from "\.\.\/http\.js"/, /XMLHttpRequest/, /WebSocket/]) {
      expect(ledger.text).not.toMatch(forbidden);
    }
  });

  it("keeps the pure engine modules free of I/O imports", () => {
    for (const name of ["indicators.ts", "strategies.ts", "risk.ts", "entryExit.ts"]) {
      const f = FILES.find((x) => x.path === join("engine", name))!;
      expect(f.text, name).not.toMatch(/from "node:(fs|http|https|net|child_process)"/);
      expect(f.text, name).not.toMatch(/\bfetch\(|httpFetch|better-sqlite3/);
    }
  });

  it("cannot be switched to live trading through configuration", () => {
    for (const mode of ["live", "real", "production", "alpaca", "ibkr", "1", "true"]) {
      expect(() => loadWorkerConfig({ TRADING_MODE: mode })).toThrow(/only 'paper'/);
    }
    expect(loadWorkerConfig({}).tradingMode).toBe("paper");
  });
});
