import { httpFetch } from "../http.js";
import { redact } from "../log.js";

export type TelegramTarget = { token: string; chatId: string; apiBase: string };

export type SendResult =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean; retryAfterSec?: number };

export type FetchLike = (url: string, init: RequestInit, timeoutMs?: number) => Promise<Response>;

/** Telegram HTML parse mode only needs these three escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_LEN = 3800; // Telegram's hard limit is 4096; leave headroom for escaping

/**
 * Send one message to the ONE configured chat. Outbound only: the bot never
 * reads updates, so there is no inbound command surface to attack. The token
 * lives in the URL path, so every error string is scrubbed before it leaves
 * this function.
 */
export async function sendTelegram(target: TelegramTarget, text: string, fetchImpl: FetchLike = httpFetch): Promise<SendResult> {
  const url = `${target.apiBase}/bot${target.token}/sendMessage`;
  const safe = (msg: string) => redact(msg).split(target.token).join("[REDACTED]");
  try {
    const res = await fetchImpl(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target.chatId,
          text: text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + "…" : text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
      15_000
    );
    if (res.ok) return { ok: true };
    let description = `HTTP ${res.status}`;
    let retryAfterSec: number | undefined;
    try {
      const body = (await res.json()) as { description?: string; parameters?: { retry_after?: number } };
      if (body.description) description = `HTTP ${res.status}: ${body.description}`;
      retryAfterSec = body.parameters?.retry_after;
    } catch {
      /* non-JSON error body */
    }
    // 429 and 5xx are transient; other 4xx (bad token, chat not found, bot blocked) will not fix themselves.
    const transient = res.status === 429 || res.status >= 500;
    return { ok: false, error: safe(description), permanent: !transient, retryAfterSec };
  } catch (err) {
    return { ok: false, error: safe(err instanceof Error ? err.message : String(err)), permanent: false };
  }
}
