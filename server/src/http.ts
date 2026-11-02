/** Default per-request budget. Covers connection, headers AND body download:
 * AbortSignal.timeout aborts the response stream too, so a provider that sends
 * headers and then stalls can no longer hold a request slot forever. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Thrown when a request exceeds its time budget (distinct from HTTP errors). */
export class FetchTimeoutError extends Error {
  constructor(url: string, ms: number) {
    super(`timeout after ${ms}ms for ${redact(url)}`);
    this.name = "FetchTimeoutError";
  }
}

// Keep query strings (which may carry crumbs/tokens) out of error messages.
function redact(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "<invalid url>";
  }
}

/**
 * Drop-in replacement for global `fetch` with a hard timeout. Resolves
 * `globalThis.fetch` at call time so tests can stub it. A caller-supplied
 * `signal` is honoured in addition to the timeout.
 */
export async function httpFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (timeout.aborted && !init.signal?.aborted) throw new FetchTimeoutError(url, timeoutMs);
    throw err;
  }
}
