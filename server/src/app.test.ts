import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = "test-api-key-0123456789";
let tmpDir: string;
let server: Server;
let base: string;
let db: (typeof import("./db.js"))["db"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ot-app-test-"));
  process.env.DATA_DIR = tmpDir;
  process.env.API_KEY = KEY;
  const { createApp } = await import("./app.js");
  ({ db } = await import("./db.js"));
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.DATA_DIR;
  delete process.env.API_KEY;
});

async function call(method: string, path: string, body?: unknown, key: string | null = KEY) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers["x-api-key"] = key;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("authentication", () => {
  it.each([
    ["GET", "/api/portfolios"],
    ["POST", "/api/portfolios"],
    ["DELETE", "/api/portfolios/1"],
    ["GET", "/api/portfolios/1/transactions"],
    ["GET", "/api/portfolios/1/positions"],
    ["POST", "/api/ai/chat"],
  ])("%s %s is rejected without a key", async (method, path) => {
    const r = await call(method, path, method === "POST" ? {} : undefined, null);
    expect(r.status).toBe(401);
  });

  it("rejects a wrong key of the same length", async () => {
    expect((await call("GET", "/api/portfolios", undefined, "x".repeat(KEY.length))).status).toBe(401);
  });

  it("rejects a wrong key of a different length", async () => {
    expect((await call("GET", "/api/portfolios", undefined, "short")).status).toBe(401);
  });

  it("rejects an empty key", async () => {
    expect((await call("GET", "/api/portfolios", undefined, "")).status).toBe(401);
  });

  it("accepts the right key", async () => {
    const r = await call("GET", "/api/portfolios");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json)).toBe(true);
  });

  it("checks auth before validating the AI body, and never reaches the model on bad input", async () => {
    expect((await call("POST", "/api/ai/chat", {}, null)).status).toBe(401);
    expect((await call("POST", "/api/ai/chat", {})).status).toBe(400);
  });

  it("does not echo the key in a 401 body", async () => {
    const r = await call("GET", "/api/portfolios", undefined, "wrong");
    expect(JSON.stringify(r.json)).not.toContain(KEY);
  });
});

describe("portfolio routes", () => {
  let pid: number;

  it("creates a portfolio and rejects duplicates and bad names", async () => {
    const created = await call("POST", "/api/portfolios", { name: "Test" });
    expect(created.status).toBe(201);
    pid = Number(created.json.id);
    expect((await call("POST", "/api/portfolios", { name: "Test" })).status).toBe(409);
    expect((await call("POST", "/api/portfolios", { name: "" })).status).toBe(400);
  });

  it("rejects non-numeric ids instead of letting SQLite coerce them", async () => {
    expect((await call("DELETE", "/api/portfolios/abc")).status).toBe(400);
    expect((await call("GET", "/api/portfolios/1abc/transactions")).status).toBe(400);
    expect((await call("GET", "/api/portfolios/0/positions")).status).toBe(400);
    expect((await call("GET", "/api/portfolios/-1/positions")).status).toBe(400);
    // Number() would accept all of these; only the strict digit check rejects them.
    for (const odd of ["1e3", "0x10", "1.5", "%201"]) {
      expect((await call("GET", `/api/portfolios/${odd}/positions`)).status).toBe(400);
    }
  });

  it("returns 404 for a portfolio that does not exist", async () => {
    expect((await call("DELETE", "/api/portfolios/999999")).status).toBe(404);
    expect((await call("GET", "/api/portfolios/999999/transactions")).status).toBe(404);
    expect((await call("GET", "/api/portfolios/999999/positions")).status).toBe(404);
    const tx = { symbol: "aapl", side: "BUY", quantity: 1, price: 1, executed_at: "2026-01-01T00:00:00Z" };
    expect((await call("POST", "/api/portfolios/999999/transactions", tx)).status).toBe(404);
  });

  it("validates transactions", async () => {
    const ok = { symbol: "aapl", side: "BUY", quantity: 1, price: 10, executed_at: "2026-01-01T00:00:00Z" };
    for (const bad of [
      { ...ok, side: "HOLD" },
      { ...ok, quantity: 0 },
      { ...ok, quantity: -1 },
      { ...ok, price: -1 },
      { ...ok, symbol: "" },
      { ...ok, symbol: "WAYTOOLONGSYMBOL" },
      { ...ok, executed_at: "not a date" },
      { ...ok, executed_at: "" },
    ]) {
      expect((await call("POST", `/api/portfolios/${pid}/transactions`, bad)).status).toBe(400);
    }
  });

  it("normalizes symbol case and executed_at to ISO-8601 UTC", async () => {
    const r = await call("POST", `/api/portfolios/${pid}/transactions`, {
      symbol: "aapl", side: "BUY", quantity: 10, price: 100, executed_at: "2026-01-05",
    });
    expect(r.status).toBe(201);
    expect(r.json.symbol).toBe("AAPL");
    expect(r.json.executed_at).toBe("2026-01-05T00:00:00.000Z");
  });

  it("computes average cost and realized P&L", async () => {
    await call("POST", `/api/portfolios/${pid}/transactions`, { symbol: "AAPL", side: "BUY", quantity: 10, price: 120, executed_at: "2026-01-06T00:00:00Z" });
    await call("POST", `/api/portfolios/${pid}/transactions`, { symbol: "AAPL", side: "SELL", quantity: 5, price: 130, executed_at: "2026-01-07T00:00:00Z" });
    const r = await call("GET", `/api/portfolios/${pid}/positions`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual([{ symbol: "AAPL", quantity: 15, avgCost: 110, realizedPnl: 100 }]);
  });

  it("orders positions replay chronologically even when inserted out of order", async () => {
    const p2 = Number((await call("POST", "/api/portfolios", { name: "Order" })).json.id);
    // Insert the sell first; by date it happens after the buy.
    await call("POST", `/api/portfolios/${p2}/transactions`, { symbol: "MSFT", side: "SELL", quantity: 5, price: 20, executed_at: "2026-02-02T00:00:00Z" });
    await call("POST", `/api/portfolios/${p2}/transactions`, { symbol: "MSFT", side: "BUY", quantity: 10, price: 10, executed_at: "2026-02-01T00:00:00Z" });
    const r = await call("GET", `/api/portfolios/${p2}/positions`);
    expect(r.json).toEqual([{ symbol: "MSFT", quantity: 5, avgCost: 10, realizedPnl: 50 }]);
  });

  it("deletes a transaction, and 404s on a repeat or a wrong portfolio", async () => {
    const list = await call("GET", `/api/portfolios/${pid}/transactions`);
    const txId = list.json[0].id;
    expect((await call("DELETE", `/api/portfolios/${pid}/transactions/${txId}`)).status).toBe(204);
    expect((await call("DELETE", `/api/portfolios/${pid}/transactions/${txId}`)).status).toBe(404);
    expect((await call("DELETE", `/api/portfolios/${pid}/transactions/zzz`)).status).toBe(400);
    const other = list.json[1].id;
    expect((await call("DELETE", `/api/portfolios/999999/transactions/${other}`)).status).toBe(404);
  });

  it("deleting a portfolio cascades to its transactions", async () => {
    const before = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE portfolio_id = ?").get(pid) as { c: number }).c;
    expect(before).toBeGreaterThan(0);
    expect((await call("DELETE", `/api/portfolios/${pid}`)).status).toBe(204);
    const after = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE portfolio_id = ?").get(pid) as { c: number }).c;
    expect(after).toBe(0);
  });
});

describe("/api/status", () => {
  it("is open, reports data quality and provider age, and exposes no symbols", async () => {
    const r = await call("GET", "/api/status", undefined, null);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.dataQuality).toMatchObject({
      tracked: expect.any(Number),
      alertEligible: expect.any(Number),
      byDelayClass: { realtime: expect.any(Number), delayed: expect.any(Number), eod: expect.any(Number), unknown: expect.any(Number) },
    });
    expect(Array.isArray(r.json.providers)).toBe(true);
    expect(r.json.dataQuality).not.toHaveProperty("symbols");
  });
});
