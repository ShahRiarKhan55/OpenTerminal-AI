import { join } from "node:path";
import { createBackup } from "../backup.js";

// Usage: node dist/scripts/backup.js [--keep N] [--dir DIR]
// Safe to run while the API and worker are running. Intended for cron / `docker compose run --rm backup`.
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dataDir = process.env.DATA_DIR || "./data";
const keepRaw = opt("--keep") || process.env.BACKUP_KEEP || "14";
const keep = Number(keepRaw);
if (!Number.isInteger(keep) || keep < 1 || keep > 3650) {
  console.error("backup: --keep / BACKUP_KEEP must be an integer between 1 and 3650");
  process.exit(2);
}
try {
  const r = createBackup({ dbFile: join(dataDir, "terminal.db"), dir: opt("--dir") ?? join(dataDir, "backups"), keep });
  console.log(`backup ok: ${r.path} (${r.bytes} bytes, schema v${r.userVersion})${r.pruned.length ? `; pruned ${r.pruned.length} old` : ""}`);
} catch (e) {
  console.error("backup FAILED:", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
