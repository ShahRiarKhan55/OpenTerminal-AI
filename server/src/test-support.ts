// Cross-platform helpers for the test suite (excluded from the production build by the test-*.ts pattern).
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { expect } from "vitest";
import { statSync } from "node:fs";

export const IS_WINDOWS = process.platform === "win32";

/**
 * Remove a temp directory robustly. On Windows a file that was opened a moment ago (SQLite WAL, antivirus or indexer scans)
 * can fail with EPERM/EBUSY for a short while, so retry with a delay; Node retries exactly those errors when maxRetries is set.
 * Windows only: a directory that is STILL locked after the retries is left in %TEMP% with a warning rather than failing an
 * otherwise-passing test. On POSIX any failure is thrown, so real leaks stay visible.
 */
export function removeDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    if (!IS_WINDOWS) throw e;
    console.warn(`[test] could not remove temp dir ${dir} (${e instanceof Error ? e.message : String(e)}); leaving it in the OS temp folder`);
  }
}

// ---- owner-only permission checks -------------------------------------------------------------------------------------
// POSIX: exact mode bits. Windows has no mode bits (mkdir's `mode` is ignored); access is governed by the ACL, which a new
// temp directory inherits from %TEMP% (the user's profile: SYSTEM, Administrators and the user only). So on Windows we assert
// that NO broad principal (Everyone, Users, Authenticated Users, ...) has an ALLOW entry. SIDs are used, not names, because
// group names are localized ("Jeder", "Benutzer", ...).

/** Well-known SIDs that must never be granted access to private data. */
export const BROAD_SIDS: Record<string, string> = {
  "S-1-1-0": "Everyone",
  "S-1-5-32-545": "BUILTIN\\Users",
  "S-1-5-11": "Authenticated Users",
  "S-1-5-4": "INTERACTIVE",
  "S-1-5-32-546": "BUILTIN\\Guests",
  "S-1-5-7": "ANONYMOUS LOGON",
  "S-1-5-2": "NETWORK",
};

export type AclEntry = { sid: string; type: string; rights: string };

/** Parse lines of the form `SID|Allow|FileSystemRights` (the format our PowerShell probe prints). Pure, unit-tested. */
export function parseAclLines(text: string): AclEntry[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sid, type, ...rest] = l.split("|");
      return { sid, type, rights: rest.join("|") };
    })
    .filter((e) => /^S-\d-/.test(e.sid) && e.type);
}

/** Names of broad principals that hold an ALLOW entry. Empty means owner-only (as far as broad groups go). */
export function broadAllowEntries(entries: AclEntry[]): string[] {
  return entries.filter((e) => /^allow$/i.test(e.type) && e.sid in BROAD_SIDS).map((e) => `${BROAD_SIDS[e.sid]} (${e.rights})`);
}

const PS_PROBE =
  "$ErrorActionPreference='Stop';" +
  "(Get-Acl -LiteralPath $env:OT_ACL_PATH).Access | ForEach-Object {" +
  "$sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;" +
  '"$sid|$($_.AccessControlType)|$($_.FileSystemRights)" }';

function windowsAcl(path: string): AclEntry[] {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(PS_PROBE, "utf16le").toString("base64")],
    { env: { ...process.env, OT_ACL_PATH: path }, encoding: "utf8", windowsHide: true }
  );
  if (r.status !== 0) throw new Error(`could not read the ACL of ${path}: ${(r.stderr || r.error?.message || "").toString().trim()}`);
  return parseAclLines(r.stdout);
}

/** Assert a directory (or file) is private to its owner: strict mode bits on POSIX, no broad ALLOW ACL entry on Windows. */
export function expectOwnerOnly(path: string, kind: "dir" | "file" = "dir"): void {
  if (!IS_WINDOWS) {
    expect(statSync(path).mode & 0o777, `${path} must be mode ${kind === "dir" ? "0700" : "0600"}`).toBe(kind === "dir" ? 0o700 : 0o600);
    return;
  }
  const entries = windowsAcl(path);
  expect(entries.length, `no ACL entries read for ${path}`).toBeGreaterThan(0);
  expect(broadAllowEntries(entries), `${path} grants access to broad groups (inherited from its parent folder?)`).toEqual([]);
}
