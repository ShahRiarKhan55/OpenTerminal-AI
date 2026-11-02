import { restoreBackup } from "../backup.js";

// Usage: node dist/scripts/restore.js <backup-file> --confirm-stopped
// Stop the api and worker FIRST (docker compose stop api worker web).
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) {
  console.error("usage: restore.js <backup-file> --confirm-stopped");
  process.exit(2);
}
try {
  const r = restoreBackup({ dataDir: process.env.DATA_DIR || "./data", backupFile: file, confirmedStopped: args.includes("--confirm-stopped") });
  console.log(`restored ${r.restoredFrom} (schema v${r.userVersion}).`);
  console.log(r.previousSavedAs ? `previous database kept at ${r.previousSavedAs}` : "no previous database existed");
  console.log("Start the services again; pending migrations (if any) apply automatically.");
} catch (e) {
  console.error("restore FAILED (nothing was changed unless stated above):", e instanceof Error ? e.message : String(e));
  process.exit(1);
}
