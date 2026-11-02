import { afterEach, describe, expect, it, vi } from "vitest";
import { FetchTimeoutError, httpFetch } from "./http.js";

afterEach(() => vi.unstubAllGlobals());

// A fetch that never answers but, like the real one, rejects when aborted.
function hangingFetch() {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })
  );
}

describe("httpFetch", () => {
  it("passes a normal response through", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const res = await httpFetch("https://example.com/x");
    expect(res.ok).toBe(true);
  });

  it("forwards headers and attaches an abort signal", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", f);
    await httpFetch("https://example.com/x", { headers: { "X-Test": "1" } });
    const init = f.mock.calls[0][1] as RequestInit;
    expect(init.headers).toEqual({ "X-Test": "1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with FetchTimeoutError when the provider hangs", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(httpFetch("https://example.com/slow", {}, 30)).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  it("keeps the query string (crumbs, tokens) out of the timeout message", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(httpFetch("https://example.com/p?crumb=SECRET", {}, 20)).rejects.toThrow(
      /^timeout after 20ms for https:\/\/example\.com\/p$/
    );
  });

  it("does not relabel a caller abort as a timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const ctl = new AbortController();
    const p = httpFetch("https://example.com/x", { signal: ctl.signal }, 5_000);
    ctl.abort(new Error("caller cancelled"));
    await expect(p).rejects.toThrow("caller cancelled");
  });

  it("propagates ordinary network errors unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNRESET")));
    await expect(httpFetch("https://example.com/x")).rejects.toThrow("ECONNRESET");
  });
});
