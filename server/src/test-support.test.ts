import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BROAD_SIDS, broadAllowEntries, parseAclLines, removeDir } from "./test-support.js";

describe("ACL parsing (locale-independent, by SID)", () => {
  const OWNER_ONLY = ["S-1-5-18|Allow|FullControl", "S-1-5-32-544|Allow|FullControl", "S-1-5-21-111-222-333-1001|Allow|FullControl"].join("\r\n");
  it("accepts an owner/SYSTEM/Administrators-only ACL, with CRLF output", () => {
    expect(parseAclLines(OWNER_ONLY)).toHaveLength(3);
    expect(broadAllowEntries(parseAclLines(OWNER_ONLY))).toEqual([]);
  });
  it.each(Object.keys(BROAD_SIDS))("flags an ALLOW entry for broad principal %s", (sid) => {
    const bad = parseAclLines(`${OWNER_ONLY}\r\n${sid}|Allow|ReadAndExecute, Synchronize`);
    expect(broadAllowEntries(bad)).toHaveLength(1);
  });
  it("does not flag a DENY entry for a broad principal", () => {
    expect(broadAllowEntries(parseAclLines("S-1-1-0|Deny|FullControl"))).toEqual([]);
  });
  it("ignores blank lines and noise", () => {
    expect(parseAclLines("\r\n  \r\nWARNING: something\r\nS-1-5-18|Allow|FullControl\r\n")).toHaveLength(1);
  });
});

describe("removeDir", () => {
  it("removes a nested tree and tolerates a missing directory", () => {
    const d = mkdtempSync(join(tmpdir(), "ot-rm-"));
    mkdirSync(join(d, "a", "b"), { recursive: true });
    writeFileSync(join(d, "a", "b", "f.txt"), "x");
    removeDir(d);
    expect(existsSync(d)).toBe(false);
    expect(() => removeDir(d)).not.toThrow();
  });
});

describe("test isolation from the real database", () => {
  it("every test file gets a temporary DATA_DIR, never the repository's data/ folder", async () => {
    const { dataDir } = await import("./db.js");
    const real = resolve(import.meta.dirname, "..", "..", "data");
    expect(resolve(dataDir)).not.toBe(real);
    expect(resolve(dataDir).startsWith(resolve(tmpdir()))).toBe(true);
  });
});
