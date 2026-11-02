import { DEFAULT_POLICY, freshnessPolicyFromEnv, type FreshnessPolicy } from "./marketdata/freshness.js";

export type Importance = "low" | "normal" | "high";
export const IMPORTANCE_RANK: Record<Importance, number> = { low: 0, normal: 1, high: 2 };

export type WorkerConfig = {
  /** Fixed. There is no code path that can place a real order. */
  tradingMode: "paper";
  pollSeconds: number;
  idlePollSeconds: number;
  candleRefreshSeconds: number;
  dailyRefreshSeconds: number;
  maxSymbols: number;
  maxCandleLagSec: number;
  newsEnabled: boolean;
  newsRefreshSeconds: number;
  alertCooldownMinutes: number;
  alertDailyCap: number;
  retentionDays: number;
  freshness: FreshnessPolicy;
  telegram: {
    enabled: boolean;
    token: string;
    chatId: string;
    apiBase: string;
    minImportance: Importance;
    dailyCap: number;
  };
  ai: {
    enabled: boolean;
    model: string;
    dailyLimit: number;
    maxTokens: number;
    minIntervalSec: number;
    timeoutMs: number;
    minImportance: Importance;
  };
  logLevel: "debug" | "info" | "warn" | "error";
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/**
 * Parse and validate worker configuration. Collects EVERY problem before
 * throwing, and never includes a variable's value in a message, so a
 * mistyped secret can't end up in a log.
 */
export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const problems: string[] = [];

  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return def;
    }
    return n;
  };
  const bool = (name: string, def: boolean): boolean => {
    const raw = env[name]?.trim().toLowerCase();
    if (raw === undefined || raw === "") return def;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    problems.push(`${name} must be true or false`);
    return def;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], def: T): T => {
    const raw = env[name]?.trim();
    if (!raw) return def;
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    problems.push(`${name} must be one of: ${allowed.join(", ")}`);
    return def;
  };

  if (env.TRADING_MODE !== undefined && env.TRADING_MODE.trim() !== "" && env.TRADING_MODE.trim().toLowerCase() !== "paper") {
    problems.push("TRADING_MODE: only 'paper' is supported; live brokerage execution is not implemented and cannot be enabled");
  }

  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.TELEGRAM_CHAT_ID ?? "").trim();
  if (token && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) problems.push("TELEGRAM_BOT_TOKEN does not look like a Telegram bot token");
  if (chatId && !/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(chatId)) problems.push("TELEGRAM_CHAT_ID must be a numeric chat id or @channelname");
  const telegramApiBase = (env.TELEGRAM_API_BASE ?? "https://api.telegram.org").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+(:\d+)?$/.test(telegramApiBase)) problems.push("TELEGRAM_API_BASE must be an http(s) origin");
  const telegramEnabled = bool("TELEGRAM_ENABLED", true) && Boolean(token && chatId);

  const hasAnthropicKey = Boolean((env.ANTHROPIC_API_KEY ?? "").trim());
  const aiDailyLimit = int("AI_DAILY_CALL_LIMIT", 10, 0, 500);
  const aiEnabled = bool("AI_ENABLED", true) && hasAnthropicKey && aiDailyLimit > 0;

  const policy = freshnessPolicyFromEnv(env);

  const cfg: WorkerConfig = {
    tradingMode: "paper",
    pollSeconds: int("MONITOR_POLL_SECONDS", 60, 15, 3600),
    idlePollSeconds: int("MONITOR_IDLE_POLL_SECONDS", 300, 60, 3600),
    candleRefreshSeconds: int("MONITOR_CANDLE_REFRESH_SECONDS", 300, 60, 3600),
    dailyRefreshSeconds: int("MONITOR_DAILY_REFRESH_SECONDS", 3600, 300, 86_400),
    maxSymbols: int("MONITOR_MAX_SYMBOLS", 40, 1, 150),
    maxCandleLagSec: int("MAX_CANDLE_LAG_SEC", 900, 60, 7200),
    newsEnabled: bool("MONITOR_NEWS_ENABLED", true),
    newsRefreshSeconds: int("MONITOR_NEWS_REFRESH_SECONDS", 900, 300, 86_400),
    alertCooldownMinutes: int("ALERT_COOLDOWN_MINUTES", 60, 1, 1440),
    alertDailyCap: int("ALERT_DAILY_CAP", 60, 1, 1000),
    retentionDays: int("DATA_RETENTION_DAYS", 90, 7, 3650),
    freshness: { ...DEFAULT_POLICY, ...policy },
    telegram: {
      enabled: telegramEnabled,
      token,
      chatId,
      apiBase: telegramApiBase,
      minImportance: oneOf("TELEGRAM_MIN_IMPORTANCE", ["low", "normal", "high"] as const, "normal"),
      dailyCap: int("TELEGRAM_DAILY_CAP", 40, 1, 500),
    },
    ai: {
      enabled: aiEnabled,
      model: (env.AI_MODEL ?? env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5").trim() || "claude-sonnet-5-5",
      dailyLimit: aiDailyLimit,
      maxTokens: int("AI_MAX_TOKENS", 500, 100, 4000),
      minIntervalSec: int("AI_MIN_INTERVAL_SEC", 30, 0, 3600),
      timeoutMs: int("AI_TIMEOUT_MS", 30_000, 1000, 120_000),
      minImportance: oneOf("AI_MIN_IMPORTANCE", ["low", "normal", "high"] as const, "normal"),
    },
    logLevel: oneOf("LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return cfg;
}
