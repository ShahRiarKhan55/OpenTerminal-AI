import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every environment variable the code reads must be documented in BOTH .env.example and
 * docs/CONFIGURATION.md, and neither document may describe a variable the code never reads.
 */
const REPO = join(import.meta.dirname, "..", "..");

function files(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (["node_modules", ".next", "dist", ".git"].includes(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p, exts));
    else if (exts.some((e) => p.endsWith(e)) && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const SOURCES = [...files(join(REPO, "server", "src"), [".ts"]), ...files(join(REPO, "web"), [".ts", ".tsx"])].filter(
  (p) => !/[\\/]test-[^\\/]*\.ts$/.test(p)
);
const text = SOURCES.map((p) => readFileSync(p, "utf8")).join("\n");

// process.env.NAME, env.NAME (config.ts takes an env object), and env["NAME"]
const used = new Set<string>();
for (const m of text.matchAll(/(?:process\.env|\benv)\.([A-Z][A-Z0-9_]+)/g)) used.add(m[1]);
for (const m of text.matchAll(/(?:process\.env|\benv)\["([A-Z][A-Z0-9_]+)"\]/g)) used.add(m[1]);
// Names passed as string literals to the config helpers: int("X", ...), bool("X", ...), oneOf("X", ...)
for (const m of text.matchAll(/\b(?:int|bool|oneOf)\(\s*"([A-Z][A-Z0-9_]+)"/g)) used.add(m[1]);
// Variables only the compose file / SDK consume but the docs promise.
const EXTRA_DOCUMENTED = new Set(["ANTHROPIC_BASE_URL", "NODE_ENV"]);

const envExample = readFileSync(join(REPO, ".env.example"), "utf8");
const configDoc = readFileSync(join(REPO, "docs", "CONFIGURATION.md"), "utf8");
const IGNORE = new Set(["NODE_ENV", "HOME", "PATH", "PWD", "TZ"]);

describe("environment variable documentation", () => {
  it("discovers a realistic number of variables (guards against scanning nothing)", () => {
    expect(used.size).toBeGreaterThan(35);
    expect(used.has("TRADING_MODE")).toBe(true);
    expect(used.has("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(used.has("AI_DAILY_CALL_LIMIT")).toBe(true);
  });

  it.each([...used].filter((v) => !IGNORE.has(v)).sort())("%s is documented in .env.example and docs/CONFIGURATION.md", (name) => {
    expect(envExample, `${name} missing from .env.example`).toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
    expect(configDoc, `${name} missing from docs/CONFIGURATION.md`).toContain("`" + name + "`");
  });

  it("documents no variable the code does not read (no stale settings)", () => {
    const documented = new Set([...envExample.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));
    const stale = [...documented].filter((n) => !used.has(n) && !EXTRA_DOCUMENTED.has(n));
    expect(stale).toEqual([]);
  });
});
