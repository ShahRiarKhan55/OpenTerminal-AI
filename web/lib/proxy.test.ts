import { describe, expect, it } from "vitest";
import { allowedHosts, checkMutation, CSRF_VALUE, hostAllowed, hostnameOf, safeResponseHeaders, validateSegments } from "./proxy";

describe("validateSegments (no path traversal through the proxy)", () => {
  it("accepts ordinary API paths", () => {
    expect(validateSegments(["monitor", "status"])).toBeNull();
    expect(validateSegments(["paper", "positions", "12", "close"])).toBeNull();
    expect(validateSegments(["quotes"])).toBeNull();
    expect(validateSegments(["history", "BRK.B"])).toBeNull();
    expect(validateSegments(["history", "^VIX"])).toBeNull();
  });
  it.each([
    [[]], [[".."]], [["."]], [[""]], [["a", ".."]], [["a/b"]], [["a\\b"]], [["a?x=1"]], [["a#b"]], [["%2e%2e"]], [["a%2fb"]],
    [["a\u0000b"]], [["a\nb"]], [["x".repeat(65)]], [Array(9).fill("a")],
  ])("rejects %j", (segs) => {
    expect(validateSegments(segs as string[])).toBe("invalid path");
  });
});

describe("host allow-list (defeats DNS rebinding)", () => {
  const allowed = allowedHosts({});
  it.each(["localhost", "localhost:3000", "LOCALHOST:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]", "[::1]:3000"])("allows %s", (h) => {
    expect(hostAllowed(h, allowed)).toBe(true);
  });
  it.each([
    "evil.com", "evil.com:3000", "localhost.evil.com", "127.0.0.1.evil.com", "evil.com/localhost", "localhost@evil.com", "localhostx",
    "", "[::2]", "0.0.0.0", "192.168.1.5:3000", "localhost:3000:80", "local host",
  ])("rejects %j", (h) => {
    expect(hostAllowed(h, allowed)).toBe(false);
  });
  it("rejects a missing Host header", () => {
    expect(hostAllowed(null, allowed)).toBe(false);
    expect(hostAllowed(undefined, allowed)).toBe(false);
  });
  it("extends the list only via ALLOWED_HOSTS, case-insensitively", () => {
    const a = allowedHosts({ ALLOWED_HOSTS: "Terminal.Example.com, ,mini.lan" });
    expect(hostAllowed("terminal.example.com:443", a)).toBe(true);
    expect(hostAllowed("mini.lan", a)).toBe(true);
    expect(hostAllowed("other.example.com", a)).toBe(false);
    expect(hostAllowed("terminal.example.com.evil.com", a)).toBe(false);
  });
  it("hostnameOf strips ports and keeps IPv6 brackets", () => {
    expect(hostnameOf("Example.com:8080")).toBe("example.com");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("bad host")).toBeNull();
  });
});

describe("checkMutation (CSRF defence)", () => {
  const same = { host: "localhost:3000", origin: "http://localhost:3000", secFetchSite: "same-origin", requestedWith: CSRF_VALUE };
  it.each(["GET", "HEAD", "OPTIONS", "get"])("never blocks a read (%s)", (method) => {
    expect(checkMutation({ method, host: "localhost:3000", origin: "http://evil.com", secFetchSite: "cross-site", requestedWith: null })).toEqual({ ok: true });
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "post"])("allows a genuine same-origin %s with the header", (method) => {
    expect(checkMutation({ method, ...same })).toEqual({ ok: true });
  });
  it("allows a request from a client that sends no Origin or Sec-Fetch-Site (non-browser) but has the header", () => {
    expect(checkMutation({ method: "POST", host: "localhost:3000", origin: null, secFetchSite: null, requestedWith: CSRF_VALUE })).toEqual({ ok: true });
  });
  it("blocks a classic cross-site form POST (no custom header)", () => {
    const r = checkMutation({ method: "POST", host: "localhost:3000", origin: "http://evil.com", secFetchSite: "cross-site", requestedWith: null });
    expect(r).toEqual({ ok: false, reason: "missing anti-CSRF header" });
  });
  it.each(["wrong", "", "OPENTERMINAL", "true"])("blocks a wrong header value %j", (v) => {
    expect(checkMutation({ method: "POST", ...same, requestedWith: v }).ok).toBe(false);
  });
  it.each(["cross-site", "same-site", "none"])("blocks Sec-Fetch-Site: %s even with the header", (site) => {
    expect(checkMutation({ method: "POST", ...same, secFetchSite: site })).toEqual({ ok: false, reason: "cross-site request" });
  });
  it("blocks an Origin that is not this origin, even if the browser omits Sec-Fetch-Site", () => {
    expect(checkMutation({ method: "DELETE", ...same, secFetchSite: null, origin: "http://evil.com" })).toEqual({ ok: false, reason: "origin mismatch" });
    expect(checkMutation({ method: "DELETE", ...same, secFetchSite: null, origin: "http://localhost:3001" }).ok).toBe(false);
    expect(checkMutation({ method: "DELETE", ...same, secFetchSite: null, origin: "null" }).ok).toBe(false);
    expect(checkMutation({ method: "DELETE", ...same, secFetchSite: null, origin: "not a url" }).ok).toBe(false);
  });
  it("matches the Origin against the Host header case-insensitively", () => {
    expect(checkMutation({ method: "POST", ...same, host: "LocalHost:3000" }).ok).toBe(true);
  });
});

describe("safeResponseHeaders", () => {
  it("passes only content-type, forbids caching, and drops cookies and everything else", () => {
    const h = safeResponseHeaders(new Headers({ "content-type": "application/json", "set-cookie": "a=b", server: "x", "x-powered-by": "y" }));
    expect(h).toEqual({ "content-type": "application/json", "cache-control": "no-store" });
  });
  it("defaults the content type", () => {
    expect(safeResponseHeaders(new Headers())["content-type"]).toBe("application/json");
  });
});
