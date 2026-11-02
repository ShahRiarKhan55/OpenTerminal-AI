import { describe, expect, it } from "vitest";
import { createLogger, redact, registerSecret } from "./log.js";

const TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";

describe("redact", () => {
  it("scrubs Telegram tokens in URLs and bare, Anthropic keys, and api-key fields", () => {
    expect(redact(`POST https://api.telegram.org/bot${TOKEN}/sendMessage failed`)).not.toContain("AAHdq");
    expect(redact(`token ${TOKEN}`)).not.toContain(TOKEN);
    expect(redact("key sk-ant-api03-abcdefghijklmnop")).toBe("key [REDACTED]");
    expect(redact('{"x-api-key":"supersecretvalue123"}')).not.toContain("supersecretvalue123");
    expect(redact("x-api-key: abc123def456")).toBe("x-api-key: [REDACTED]");
  });

  it("scrubs registered literal secrets everywhere they appear", () => {
    registerSecret("my-literal-secret-9876");
    expect(redact("a my-literal-secret-9876 b my-literal-secret-9876")).toBe("a [REDACTED] b [REDACTED]");
  });

  it("ignores too-short 'secrets' so ordinary words are not mangled", () => {
    registerSecret("ab");
    expect(redact("abracadabra")).toBe("abracadabra");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("AAPL breakout at 200.10")).toBe("AAPL breakout at 200.10");
  });
});

describe("createLogger", () => {
  const collect = (level?: "debug" | "info" | "warn" | "error") => {
    const lines: string[] = [];
    const log = createLogger({ level, sink: (l) => lines.push(l), now: () => Date.UTC(2026, 10, 2) });
    return { log, lines };
  };

  it("writes one JSON object per line with ts, level, msg and fields", () => {
    const { log, lines } = collect();
    log.info("hello", { symbol: "AAPL", n: 3 });
    expect(JSON.parse(lines[0])).toEqual({ ts: "2026-11-02T00:00:00.000Z", level: "info", msg: "hello", symbol: "AAPL", n: 3 });
  });

  it("filters below the configured level", () => {
    const { log, lines } = collect("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(["w", "e"]);
  });

  it("redacts secrets that arrive through fields and Error messages", () => {
    const { log, lines } = collect();
    log.error("send failed", { err: new Error(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage`), url: `bot${TOKEN}` });
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain("AAHdq");
    expect(JSON.parse(lines[0]).err.message).toContain("[REDACTED]");
  });

  it("never throws on circular fields", () => {
    const { log, lines } = collect();
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => log.info("x", { a })).not.toThrow();
    expect(JSON.parse(lines[0]).note).toBe("unserializable fields");
  });
});
