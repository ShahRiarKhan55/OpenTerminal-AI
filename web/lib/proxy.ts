/**
 * Request validation for the same-origin API proxy (web/app/api/[...path]/route.ts).
 *
 * The proxy attaches the secret API key to whatever reaches it, so IT must decide what is allowed to
 * reach the API. Two browser-based attacks target exactly this on a localhost dashboard:
 *   - CSRF: any website you visit can make your browser send a "simple" cross-site POST to
 *     http://localhost:3000/api/...; without checks it would be executed with your key.
 *   - DNS rebinding: an attacker's domain re-pointed at 127.0.0.1 gets same-origin access to the proxy
 *     (and so to the key) from the attacker's page, unless the Host header is validated.
 */

export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "openterminal";

export const MAX_BODY_BYTES = 64 * 1024;

/** A proxied path must be plain URL segments: no traversal, separators, encoded slashes or control characters. */
export function validateSegments(segments: string[]): string | null {
  if (segments.length === 0 || segments.length > 8) return "invalid path";
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return "invalid path";
    // eslint-disable-next-line no-control-regex
    if (/[\/\\\u0000-\u001f\u007f?#%]/.test(s)) return "invalid path";
    if (s.length > 64) return "invalid path";
  }
  return null;
}

export function allowedHosts(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return ["localhost", "127.0.0.1", "[::1]", ...extra];
}

/** `Host` header (with optional port) -> lower-case hostname. IPv6 literals keep their brackets. */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase();
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/.exec(h);
  return m ? m[1] : null;
}

export function hostAllowed(hostHeader: string | null | undefined, allowed: string[]): boolean {
  const name = hostnameOf(hostHeader);
  return name !== null && allowed.includes(name);
}

export type MutationCheck = { ok: true } | { ok: false; reason: string };

/**
 * State-changing requests must prove they come from OUR page:
 *   - a custom header (cross-site JS cannot send one without a CORS preflight, which this proxy never grants), and
 *   - if the browser reports a site/origin, it must be this very origin.
 */
export function checkMutation(h: {
  method: string;
  host: string | null;
  origin: string | null;
  secFetchSite: string | null;
  requestedWith: string | null;
}): MutationCheck {
  if (["GET", "HEAD", "OPTIONS"].includes(h.method.toUpperCase())) return { ok: true };
  if (h.requestedWith !== CSRF_VALUE) return { ok: false, reason: "missing anti-CSRF header" };
  if (h.secFetchSite !== null && h.secFetchSite !== "same-origin") return { ok: false, reason: "cross-site request" };
  if (h.origin !== null) {
    let originHost: string | null = null;
    try {
      originHost = new URL(h.origin).host.toLowerCase();
    } catch {
      /* malformed -> rejected below */
    }
    if (originHost === null || originHost !== (h.host ?? "").toLowerCase()) return { ok: false, reason: "origin mismatch" };
  }
  return { ok: true };
}

/** Response headers worth passing back to the browser (everything else, e.g. Set-Cookie, is dropped). */
export function safeResponseHeaders(upstream: Headers): Record<string, string> {
  return { "content-type": upstream.get("content-type") ?? "application/json", "cache-control": "no-store" };
}
