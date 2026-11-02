import { NextRequest, NextResponse } from "next/server";
import { getApiKey } from "@/lib/api-key";
import { allowedHosts, checkMutation, CSRF_HEADER, hostAllowed, MAX_BODY_BYTES, safeResponseHeaders, validateSegments } from "@/lib/proxy";

// A route handler (rather than next.config.ts rewrites) because rewrites
// can't attach a header to the proxied request — and the shared API key
// must never reach the browser, only travel server-to-server.
//
// Because this handler attaches the key to whatever reaches it, it is also the security boundary
// against CSRF and DNS rebinding: see lib/proxy.ts for the rules enforced below.
const API_URL = process.env.API_URL ?? "http://localhost:4000";
const UPSTREAM_TIMEOUT_MS = 30_000;
const HOSTS = allowedHosts();

const deny = (status: number, error: string) => NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });

async function proxy(req: NextRequest, path: string[]): Promise<NextResponse> {
  const host = req.headers.get("host");
  if (!hostAllowed(host, HOSTS)) return deny(403, "host not allowed (set ALLOWED_HOSTS to serve this dashboard from another hostname)");

  const bad = validateSegments(path);
  if (bad) return deny(400, bad);

  const m = checkMutation({
    method: req.method,
    host,
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    requestedWith: req.headers.get(CSRF_HEADER),
  });
  if (!m.ok) return deny(403, `request refused: ${m.reason}`);

  const url = `${API_URL}/api/${path.join("/")}${req.nextUrl.search}`;
  const apiKey = getApiKey();

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (apiKey) headers.set("x-api-key", apiKey);
  // Relayed, not fabricated: only meaningful (and only trusted by the API)
  // when TRUST_PROXY=1 is set there — see server/src/index.ts.
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) headers.set("x-forwarded-for", forwardedFor);

  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE";
  let body: string | undefined;
  if (hasBody) {
    body = await req.text();
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return deny(413, "request body too large");
  }

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: req.method, headers, body, cache: "no-store", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    // Never surface internals (hostnames, stack traces) when the API is down or slow.
    return deny(502, "the API is unavailable");
  }

  const buf = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new NextResponse(buf, { status: upstream.status, headers: safeResponseHeaders(upstream.headers) });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: RouteContext) {
  return proxy(req, (await ctx.params).path);
}
