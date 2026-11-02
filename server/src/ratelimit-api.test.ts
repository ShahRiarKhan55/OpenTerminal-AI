import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const KEY = "ratelimit-test-key-0123456789";
let tmpDir: string;
let server: Server;
let base: string;
let db: (typeof import("./db.js"))["db"];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "ot-rl-test-"));
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

describe("rate limiting", () => {
  it("throttles a flood (including unauthenticated key-guessing) with 429 and Retry-After", async () => {
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 260; i++) {
      const r = await fetch(`${base}/api/paper/account`, { headers: { "x-api-key": i % 2 ? KEY : "guess-" + i } });
      statuses.push(r.status);
      if (r.status === 429) retryAfter ??= r.headers.get("retry-after");
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    // while limited, even a CORRECT key is refused: a guesser cannot out-run the limiter
    const limited = await fetch(`${base}/api/paper/account`, { headers: { "x-api-key": KEY } });
    expect(limited.status).toBe(429);
  });
});
