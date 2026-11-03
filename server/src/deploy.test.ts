import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * Static guardrails for the deployment files. The properties here were also verified against real
 * running containers (isolation, read-only rootfs, dropped capabilities, restart/health, backup/restore);
 * these tests stop them silently regressing.
 */
const REPO = join(import.meta.dirname, "..", "..");
// Windows checkouts (core.autocrlf) turn LF into CRLF: normalise so line-based parsing never sees a stray "\r".
const read = (p: string) => readFileSync(join(REPO, p), "utf8").replace(/\r\n/g, "\n");
const compose = parse(read("docker-compose.yml"), { merge: true }) as {
  services: Record<string, Record<string, any>>;
  volumes: Record<string, unknown>;
};
const envNames = (svc: string): string[] => (compose.services[svc].environment as string[]).map((e) => e.split("=")[0]);
const LONG_RUNNING = ["api", "worker", "web"];

describe("docker-compose.yml", () => {
  it("defines exactly the expected services", () => {
    expect(Object.keys(compose.services).sort()).toEqual(["api", "backup", "web", "worker"]);
  });

  it.each(["api", "worker", "web", "backup"])("%s is hardened: read-only rootfs, no capabilities, no privilege escalation, init, rotated logs", (svc) => {
    const s = compose.services[svc];
    expect(s.read_only).toBe(true);
    expect(s.cap_drop).toEqual(["ALL"]);
    expect(s.security_opt).toContain("no-new-privileges:true");
    expect(s.init).toBe(true);
    expect(s.logging).toMatchObject({ driver: "json-file", options: { "max-size": "10m", "max-file": "5" } });
    expect(s.privileged).toBeUndefined();
    expect(s.network_mode).toBeUndefined();
    expect(s.pid).toBeUndefined();
    expect(s.cap_add).toBeUndefined();
  });

  it.each(LONG_RUNNING)("%s restarts automatically after a crash", (svc) => {
    expect(compose.services[svc].restart).toBe("unless-stopped");
  });

  it("every published port is bound to loopback only", () => {
    for (const svc of LONG_RUNNING) for (const p of (compose.services[svc].ports ?? []) as string[]) expect(p, `${svc} ${p}`).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });

  it("the only storage is the named data volume (no host bind mounts, no docker socket)", () => {
    expect(Object.keys(compose.volumes)).toEqual(["terminal-data"]);
    for (const [name, s] of Object.entries(compose.services)) {
      for (const v of (s.volumes ?? []) as string[]) expect(v, `${name}: ${v}`).toMatch(/^terminal-data:\/data(:ro)?$/);
    }
    expect(read("docker-compose.yml")).not.toMatch(/docker\.sock/);
  });

  it("the web tier is read-only on the data volume and holds only the API key and routing settings", () => {
    expect(compose.services.web.volumes).toEqual(["terminal-data:/data:ro"]);
    expect(envNames("web").sort()).toEqual(["ALLOWED_HOSTS", "API_KEY", "API_KEY_FILE", "API_URL"]);
  });

  it("credentials are least-privilege: Telegram only in the worker, nothing sensitive in the web tier", () => {
    for (const svc of ["api", "web", "backup"]) expect(envNames(svc).filter((n) => n.startsWith("TELEGRAM_")), svc).toEqual([]);
    expect(envNames("worker")).toEqual(expect.arrayContaining(["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]));
    expect(envNames("web").filter((n) => /ANTHROPIC|TELEGRAM|AI_/.test(n))).toEqual([]);
    expect(envNames("backup").filter((n) => /KEY|TOKEN|SECRET/.test(n))).toEqual([]);
  });

  it("the worker is pinned to paper mode, waits for a healthy API, and has a heartbeat health check", () => {
    const w = compose.services.worker;
    expect(w.environment).toContain("TRADING_MODE=paper");
    expect(w.depends_on.api.condition).toBe("service_healthy");
    expect(w.healthcheck.test).toEqual(["CMD", "node", "dist/worker/healthcheck.js"]);
    expect(w.stop_grace_period).toBe("30s");
  });

  it("web and api health checks exist (image-level) and web waits for the API", () => {
    expect(compose.services.web.depends_on.api.condition).toBe("service_healthy");
    expect(read("server/Dockerfile")).toMatch(/HEALTHCHECK/);
    expect(read("web/Dockerfile")).toMatch(/HEALTHCHECK/);
  });

  it("the backup job is on-demand only (profile) and never restarts", () => {
    expect(compose.services.backup.profiles).toEqual(["tools"]);
    expect(compose.services.backup.restart).toBe("no");
  });

  it("no secret has a hard-coded value: every credential is a substitution", () => {
    for (const svc of Object.keys(compose.services)) {
      for (const e of ((compose.services[svc].environment ?? []) as string[]).filter((x) => /KEY|TOKEN|SECRET|PASSWORD/.test(x.split("=")[0]))) {
        expect(e, `${svc}: ${e}`).toMatch(/=\$\{[A-Z_]+:-\}$|=\/data\/\.api-key$/);
      }
    }
  });

  it("every worker setting in the compose file is a documented variable, and vice versa for the worker-only ones", () => {
    const doc = read("docs/CONFIGURATION.md");
    for (const n of envNames("worker")) expect(doc, n).toContain("`" + n + "`");
  });
});

describe("Dockerfiles", () => {
  for (const f of ["server/Dockerfile", "web/Dockerfile"]) {
    const text = read(f);
    it(`${f}: unprivileged, reproducible, pinned, no baked-in secrets`, () => {
      expect(text).toMatch(/^USER node$/m);
      expect(text).toMatch(/npm ci /);
      expect(text).not.toMatch(/npm install/);
      expect(text).toMatch(/--ignore-scripts/);
      for (const m of text.matchAll(/^FROM (\S+)/gm)) expect(m[1], "base image must be pinned to a version").toMatch(/^node:22-slim$|^(build|deps)$/);
      expect(text).not.toMatch(/ARG\s+\w*(KEY|TOKEN|SECRET|PASSWORD)/i);
      expect(text).not.toMatch(/ENV\s+\w*(KEY|TOKEN|SECRET|PASSWORD)\w*=/i);
      expect(text).not.toMatch(/:latest/);
    });
  }
  it("the server image proves at build time that the native SQLite module loads", () => {
    expect(read("server/Dockerfile")).toMatch(/require\('better-sqlite3'\)/);
  });
  it(".dockerignore keeps secrets, data and VCS history out of the build context", () => {
    const ig = read(".dockerignore").split("\n").map((l) => l.trim());
    for (const p of [".git", ".env", "data", "**/node_modules"]) expect(ig).toContain(p);
  });
});

describe("release metadata", () => {
  const version = (p: string) => JSON.parse(read(p)).version as string;
  it("root, server and web manifests share one version, and the API reports it", () => {
    const v = version("package.json");
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(version("server/package.json")).toBe(v);
    expect(version("web/package.json")).toBe(v);
    expect(read("server/src/routes/trading.ts")).toContain(`const SECRETLESS_VERSION = "${v}";`);
  });
  it("the changelog documents the current version", () => {
    expect(read("CHANGELOG.md")).toContain(`## ${version("package.json")}`);
  });
  it("keeps the upstream licence and attribution", () => {
    expect(read("LICENSE")).toMatch(/MIT License/);
    expect(read("NOTICE.md")).toMatch(/ErTasselli\/OpenTerminal/);
    expect(read("NOTICE.md")).toMatch(/day-trader-skill/);
  });
});
