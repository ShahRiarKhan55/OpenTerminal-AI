import { describe, expect, it } from "vitest";
import { ConfigError, loadWorkerConfig } from "./config.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";

describe("loadWorkerConfig", () => {
  it("has safe defaults with nothing set: paper only, telegram and AI off", () => {
    const c = loadWorkerConfig({});
    expect(c.tradingMode).toBe("paper");
    expect(c.telegram.enabled).toBe(false);
    expect(c.ai.enabled).toBe(false);
    expect(c.pollSeconds).toBe(60);
    expect(c.freshness.requireOpenMarket).toBe(true);
    expect(c.ai.dailyLimit).toBe(10);
  });

  it.each(["live", "real", "LIVE", "alpaca", "1"])("refuses TRADING_MODE=%s", (mode) => {
    expect(() => loadWorkerConfig({ TRADING_MODE: mode })).toThrow(/only 'paper' is supported/);
  });
  it("accepts TRADING_MODE=paper in any case", () => {
    expect(loadWorkerConfig({ TRADING_MODE: "Paper" }).tradingMode).toBe("paper");
  });

  it("enables Telegram only when both token and chat id are present and valid", () => {
    expect(loadWorkerConfig({ TELEGRAM_BOT_TOKEN: TOKEN }).telegram.enabled).toBe(false);
    expect(loadWorkerConfig({ TELEGRAM_CHAT_ID: "42" }).telegram.enabled).toBe(false);
    expect(loadWorkerConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "-100123" }).telegram.enabled).toBe(true);
    expect(loadWorkerConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "@mychannel" }).telegram.enabled).toBe(true);
    expect(loadWorkerConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "1", TELEGRAM_ENABLED: "false" }).telegram.enabled).toBe(false);
  });

  it("rejects malformed Telegram settings without echoing their values", () => {
    try {
      loadWorkerConfig({ TELEGRAM_BOT_TOKEN: "not-a-token-SECRETVALUE", TELEGRAM_CHAT_ID: "bad chat!" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).problems).toHaveLength(2);
      expect((e as Error).message).not.toContain("SECRETVALUE");
      expect((e as Error).message).not.toContain("bad chat");
    }
  });

  it("enables AI only with a key AND a positive daily limit", () => {
    expect(loadWorkerConfig({ ANTHROPIC_API_KEY: "sk-x" }).ai.enabled).toBe(true);
    expect(loadWorkerConfig({ ANTHROPIC_API_KEY: "sk-x", AI_DAILY_CALL_LIMIT: "0" }).ai.enabled).toBe(false);
    expect(loadWorkerConfig({ ANTHROPIC_API_KEY: "sk-x", AI_ENABLED: "false" }).ai.enabled).toBe(false);
    expect(loadWorkerConfig({ AI_DAILY_CALL_LIMIT: "5" }).ai.enabled).toBe(false);
  });

  it("prefers AI_MODEL, then ANTHROPIC_MODEL, then the default", () => {
    expect(loadWorkerConfig({}).ai.model).toBe("claude-sonnet-5-5");
    expect(loadWorkerConfig({ ANTHROPIC_MODEL: "m-a" }).ai.model).toBe("m-a");
    expect(loadWorkerConfig({ ANTHROPIC_MODEL: "m-a", AI_MODEL: "m-b" }).ai.model).toBe("m-b");
  });

  it("collects every problem at once and bounds numeric settings", () => {
    try {
      loadWorkerConfig({ MONITOR_POLL_SECONDS: "1", AI_DAILY_CALL_LIMIT: "99999", ALERT_DAILY_CAP: "abc", LOG_LEVEL: "loud", MONITOR_NEWS_ENABLED: "maybe" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ConfigError).problems).toHaveLength(5);
    }
  });

  it("enforces a minimum poll interval to respect provider rate limits", () => {
    expect(() => loadWorkerConfig({ MONITOR_POLL_SECONDS: "5" })).toThrow(/MONITOR_POLL_SECONDS/);
    expect(loadWorkerConfig({ MONITOR_POLL_SECONDS: "15" }).pollSeconds).toBe(15);
  });

  it("rejects an unsafe Telegram API base", () => {
    expect(() => loadWorkerConfig({ TELEGRAM_API_BASE: "file:///etc/passwd" })).toThrow(/TELEGRAM_API_BASE/);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Docker Compose passes every optional variable as an EMPTY STRING when it is unset (`VAR=${VAR:-}`), and
 * `cp .env.example .env` ships them blank. Empty must therefore mean exactly "not set" everywhere.
 * (Regression: TELEGRAM_API_BASE= made the worker refuse to start in every compose deployment.)
 */
describe("empty environment variables behave exactly like unset ones", () => {
  const REPO = join(import.meta.dirname, "..", "..");
  const parseEnvFile = (text: string): Record<string, string> =>
    Object.fromEntries(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
    );

  const compose = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
  const workerBlock = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  web:"));
  const composeVars = [...workerBlock.matchAll(/^\s+- ([A-Z][A-Z0-9_]+)=\$\{/gm)].map((m) => m[1]);

  it("finds the compose pass-through list (guards against scanning nothing)", () => {
    expect(composeVars.length).toBeGreaterThan(25);
    expect(composeVars).toContain("TELEGRAM_API_BASE");
  });

  it("the worker config is identical when every compose-passed variable is an empty string", () => {
    const allEmpty = Object.fromEntries(composeVars.map((v) => [v, ""]));
    expect(loadWorkerConfig(allEmpty)).toEqual(loadWorkerConfig({}));
  });

  it("each variable individually: empty never throws and never changes the result", () => {
    const base = loadWorkerConfig({});
    for (const v of composeVars) expect(loadWorkerConfig({ [v]: "" }), v).toEqual(base);
  });

  it("whitespace-only values are also treated as unset", () => {
    expect(loadWorkerConfig({ TELEGRAM_API_BASE: "   ", AI_MODEL: "  ", ANTHROPIC_MODEL: "m-a" })).toMatchObject({ ai: { model: "m-a" } });
  });

  it("an empty AI_MODEL does not mask ANTHROPIC_MODEL (the fallback chain skips blanks)", () => {
    expect(loadWorkerConfig({ AI_MODEL: "", ANTHROPIC_MODEL: "claude-x" }).ai.model).toBe("claude-x");
  });

  it("the shipped .env.example loads without error and equals the defaults", () => {
    const fromExample = parseEnvFile(readFileSync(join(REPO, ".env.example"), "utf8"));
    expect(Object.keys(fromExample).length).toBeGreaterThan(30);
    expect(loadWorkerConfig(fromExample)).toEqual(loadWorkerConfig({}));
  });
});
