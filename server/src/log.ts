/**
 * Minimal structured logger (one JSON object per line on stdout/stderr) with
 * secret redaction. Redaction is applied to the final serialized line, so a
 * secret cannot leak through an error message, URL or nested field.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const secrets = new Set<string>();

/** Register a literal secret value (API key, bot token) to be scrubbed from all log output. */
export function registerSecret(value: string | undefined | null): void {
  if (value && value.length >= 6) secrets.add(value);
}

// Shapes of credentials that must never be logged even if not registered.
const PATTERNS: RegExp[] = [
  /bot\d{6,}:[A-Za-z0-9_-]{20,}/g, // Telegram bot token inside an API URL
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g, // bare Telegram bot token
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API key
  /(x-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, // API key header/field
];

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  for (const re of PATTERNS) out = out.replace(re, (m, p1) => (typeof p1 === "string" && p1 ? `${p1}[REDACTED]` : "[REDACTED]"));
  return out;
}

export type Logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => void;
  info: (msg: string, fields?: Record<string, unknown>) => void;
  warn: (msg: string, fields?: Record<string, unknown>) => void;
  error: (msg: string, fields?: Record<string, unknown>) => void;
};

export function createLogger(opts: { level?: LogLevel; sink?: (line: string, level: LogLevel) => void; now?: () => number } = {}): Logger {
  const min = ORDER[opts.level ?? "info"];
  const now = opts.now ?? Date.now;
  const sink =
    opts.sink ??
    ((line: string, level: LogLevel) => {
      (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
    });
  const emit = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    let line: string;
    try {
      line = JSON.stringify({ ts: new Date(now()).toISOString(), level, msg, ...fields }, (_k, v) =>
        v instanceof Error ? { name: v.name, message: v.message } : v
      );
    } catch {
      line = JSON.stringify({ ts: new Date(now()).toISOString(), level, msg, note: "unserializable fields" });
    }
    sink(redact(line), level);
  };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
