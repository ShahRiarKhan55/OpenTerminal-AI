import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = "security-test-key-0123456789abcdef";
const CANARIES = { ANTHROPIC_API_KEY: "sk-ant-CANARY-aaaaaaaaaaaaaaaa", TELEGRAM_BOT_TOKEN: "987654321:CANARYtokenBBBBBBBBBBBBBBBBBBBBBBBBBBB", TELEGRAM_CHAT_ID: "424242" };
let tmpDir: string;
let server: Server;
let base: string;
let db: (typeof import("./db.js"))["db"];

beforeAll(async () => {
  tmpDir = join(mkdtempSync(join(tmpdir(), "ot-sec-test-")), "fresh-data-dir");
  process.env.DATA_DIR = tmpDir;
  process.env.API_KEY = KEY;
  process.env.WEB_ORIGIN = "http://localhost:3000";
  Object.assign(process.env, CANARIES);
  const { createApp } = await import("./app.js");
  ({ db } = await import("./db.js"));
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(join(tmpDir, ".."), { recursive: true, force: true });
  for (const k of ["DATA_DIR", "API_KEY", "WEB_ORIGIN", ...Object.keys(CANARIES)]) delete process.env[k];
});

type Opts = { method?: string; key?: string | null; headers?: Record<string, string>; body?: string; json?: unknown };
async function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { ...o.headers };
  if (o.key !== null) headers["x-api-key"] = o.key ?? KEY;
  let body = o.body;
  if (o.json !== undefined) {
    body = JSON.stringify(o.json);
    headers["content-type"] = "application/json";
  }
  const res = await fetch(base + path, { method: o.method ?? "GET", headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, text, json };
}

describe("response hardening", () => {
  it("sends restrictive headers and does not advertise the framework", async () => {
    const r = await call("/api/status", { key: null });
    expect(r.headers.get("x-powered-by")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("answers unknown routes with JSON, not an HTML error page", async () => {
    const r = await call("/api/definitely-not-a-route", { key: null });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not found" });
  });

  it("answers malformed JSON with a clean 400 and no stack trace", async () => {
    const r = await call("/api/risk/config", { method: "PUT", headers: { "content-type": "application/json" }, body: '{"maxOpenPositions": ' });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid JSON body" });
    expect(r.text).not.toMatch(/at .*\.(js|ts):\d+|node_modules|SyntaxError/);
  });

  it("rejects an oversized body with 413 before it reaches any handler", async () => {
    const r = await call("/api/watchlists", { method: "POST", json: { name: "x".repeat(100_000) } });
    expect(r.status).toBe(413);
    expect(r.json).toEqual({ error: "request body too large" });
  });

  it("keeps the private data directory owner-only", () => {
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(tmpDir, "backups")).mode & 0o777).toBe(0o700);
  });
});

describe("authentication cannot be sidestepped", () => {
  it.each([
    ["key in the query string", "/api/paper/account?api_key=" + KEY, {}],
    ["key as a bearer token", "/api/paper/account", { authorization: `Bearer ${KEY}` }],
    ["key in a cookie", "/api/paper/account", { cookie: `x-api-key=${KEY}` }],
    ["a differently named header", "/api/paper/account", { "x-api-token": KEY }],
    ["a forwarded-for header claiming localhost", "/api/paper/account", { "x-forwarded-for": "127.0.0.1", "x-real-ip": "127.0.0.1" }],
    ["a host header claiming localhost", "/api/paper/account", { host: "localhost" }],
  ])("rejects %s", async (_n, path, headers) => {
    expect((await call(path, { key: null, headers: headers as Record<string, string> })).status).toBe(401);
  });

  it("rejects near-miss keys (prefix, suffix, case, whitespace)", async () => {
    // (Leading/trailing whitespace is stripped by HTTP itself, so only interior changes are meaningful.)
    for (const k of [KEY.slice(0, -1), KEY + "x", KEY.toUpperCase(), KEY.slice(0, 5) + " " + KEY.slice(5), KEY.slice(1), KEY.replace("t", "T")]) {
      expect((await call("/api/paper/account", { key: k })).status).toBe(401);
    }
  });

  it("method override headers do not turn a GET into a mutation", async () => {
    const r = await call("/api/paper/account", { headers: { "x-http-method-override": "DELETE" } });
    expect(r.status).toBe(200);
  });
});

describe("CORS", () => {
  it("allows only the configured web origin", async () => {
    const ok = await call("/api/status", { key: null, headers: { origin: "http://localhost:3000" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const evil = await call("/api/status", { key: null, headers: { origin: "http://evil.example" } });
    expect(evil.headers.get("access-control-allow-origin")).toBe("http://localhost:3000"); // never echoes the attacker's origin
    expect(evil.headers.get("access-control-allow-origin")).not.toBe("http://evil.example");
    expect(evil.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("injection resistance (SQL, markup, traversal) across every engine endpoint", () => {
  const PAYLOADS = [
    "' OR '1'='1", "'; DROP TABLE alerts; --", "1; DELETE FROM paper_positions", "\" OR 1=1 --", "AAPL' UNION SELECT * FROM settings --",
    "<script>alert(1)</script>", "../../etc/passwd", "%00", "${7*7}", "{{7*7}}", "\u0000", "A".repeat(500),
  ];
  const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
  const TABLES = ["alerts", "signals", "paper_positions", "paper_orders", "watchlists", "watchlist_items", "settings", "audit_log", "reports", "events", "paper_account", "portfolios"];

  it("never errors with a 5xx, never executes the payload, and leaves every table intact", async () => {
    // seed something so a destructive statement would be observable
    db.prepare("INSERT INTO reports (kind, period_key, created_at, title, body, data) VALUES ('daily','sec-test',1,'t','b','{}')").run();
    const before = Object.fromEntries(TABLES.map((t) => [t, count(t)]));
    const statuses: number[] = [];
    for (const p of PAYLOADS) {
      const q = encodeURIComponent(p);
      const calls = [
        call(`/api/alerts?type=${q}&importance=${q}&limit=${q}&beforeId=${q}`),
        call(`/api/signals?status=${q}`),
        call(`/api/audit?kind=${q}&symbol=${q}`),
        call(`/api/reports?kind=${q}`),
        call(`/api/paper/positions?status=${q}`),
        call(`/api/watchlists/${q}`),
        call(`/api/watchlists/1/symbols/${q}`, { method: "DELETE" }),
        call(`/api/alerts/${q}/ack`, { method: "POST" }),
        call(`/api/paper/positions/${q}/close`, { method: "POST" }),
        call(`/api/reports/${q}`),
        call("/api/watchlists", { method: "POST", json: { name: p } }),
        call("/api/watchlists/1/symbols", { method: "POST", json: { symbol: p } }),
        call("/api/watchlists/1/symbols", { method: "PUT", json: { symbols: [p] } }),
        call("/api/paper/positions/1", { method: "PATCH", json: { notes: p } }),
        call("/api/risk/config", { method: "PUT", json: { entryStart: p, minPrice: p } }),
        call("/api/portfolios", { method: "POST", json: { name: p } }),
      ];
      for (const r of await Promise.all(calls)) statuses.push(r.status);
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
    for (const t of TABLES) {
      // free-text names/notes may legitimately be stored as plain data; destructive statements must not run
      expect(count(t), t).toBeGreaterThanOrEqual(before[t] - 0);
    }
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'alerts'").get()).toBeTruthy();
    expect(db.prepare("SELECT 1 FROM reports WHERE period_key = 'sec-test'").get()).toBeTruthy();
    expect(count("paper_account")).toBe(1);
  });

  it("stores hostile free text as inert data and returns it as JSON strings (the UI renders text, never HTML)", async () => {
    const name = "<img src=x onerror=alert(1)>";
    const c = await call("/api/watchlists", { method: "POST", json: { name } });
    expect(c.status).toBe(201);
    const list = await call("/api/watchlists");
    expect(list.headers.get("content-type")).toContain("application/json");
    expect(list.json.find((w: { name: string }) => w.name === name)).toBeTruthy();
    await call(`/api/watchlists/${c.json.id}`, { method: "DELETE" });
  });
});

describe("secrets never leave the process through the API", () => {
  it("none of the canary secrets appears in any GET response", async () => {
    const paths = [
      "/api/status", "/api/monitor/status", "/api/risk/config", "/api/watchlists", "/api/alerts?limit=200", "/api/signals?limit=200",
      "/api/paper/account", "/api/paper/positions?limit=200", "/api/paper/orders?limit=200", "/api/reports", "/api/audit?limit=200",
      "/api/portfolios",
    ];
    for (const p of paths) {
      const r = await call(p);
      const all = r.text + JSON.stringify([...r.headers.entries()]);
      for (const [name, secret] of Object.entries(CANARIES)) expect(all, `${name} leaked via ${p}`).not.toContain(secret);
      expect(all, `API key leaked via ${p}`).not.toContain(KEY);
    }
  });

  it("error responses do not echo the API key or internals", async () => {
    for (const r of [await call("/api/paper/account", { key: "wrong" }), await call("/api/alerts?limit=abc"), await call("/api/nope")]) {
      expect(r.text).not.toContain(KEY);
      expect(r.text).not.toMatch(/\/home\/|node_modules|better-sqlite3|at \w+ \(/);
    }
  });
});
