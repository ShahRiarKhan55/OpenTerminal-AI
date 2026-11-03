// Runs before EVERY test file. If a file (or an earlier file in the same worker) has not chosen a DATA_DIR, give it a fresh
// temporary one, so importing db.ts can never open, migrate or back up the real data/terminal.db.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = mkdtempSync(join(process.env.OT_TEST_ROOT || tmpdir(), "data-"));
}
