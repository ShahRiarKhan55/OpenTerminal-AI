// Runs once per vitest run. Gives every test file its own throw-away DATA_DIR root and proves, at the end, that the
// developer's REAL data/terminal.db was never touched (db.ts opens `DATA_DIR || ../data` at import time).
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeDir } from "./test-support.js";

const REAL_DB = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "terminal.db");
const fingerprint = () => {
  try {
    const s = statSync(REAL_DB);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return "absent";
  }
};

let root = "";
let before = "";

export function setup() {
  root = mkdtempSync(join(tmpdir(), "ot-vitest-"));
  process.env.OT_TEST_ROOT = root; // inherited by the test workers
  before = fingerprint();
}

export function teardown() {
  const after = fingerprint();
  removeDir(root);
  if (after !== before) {
    // vitest only logs an error thrown from teardown ("error during close") and still exits 0, so also force a failing exit code.
    process.exitCode = 1;
    throw new Error(
      `The real database ${REAL_DB} changed during the test run (${before} -> ${after}). Tests must use temporary DATA_DIRs. ` +
        "If the dev server or worker was running against that database it may be the cause: stop it and re-run."
    );
  }
}
