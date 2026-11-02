import type { Request, Response } from "express";
import { z } from "zod";

/** Route params arrive as strings; accept only plain positive integers (not "1e3", "0x10", "1.5"). */
export function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export const LimitSchema = z.coerce.number().int().min(1).max(200).default(50);

/** Parse a query object with a zod schema; on failure answers 400 and returns null. */
export function parseQuery<S extends z.ZodTypeAny>(req: Request, res: Response, schema: S): z.infer<S> | null {
  const r = schema.safeParse(req.query);
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".") || "query"}: ${i.message}`).join("; ") });
    return null;
  }
  return r.data;
}

export function parseBody<S extends z.ZodTypeAny>(req: Request, res: Response, schema: S): z.infer<S> | null {
  const r = schema.safeParse(req.body ?? {});
  if (!r.success) {
    res.status(400).json({ error: r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });
    return null;
  }
  return r.data;
}

/** JSON columns are written by us, but never let one corrupt row take a list endpoint down. */
export function safeJson<T = unknown>(raw: string | null | undefined, fallback: T | null = null): T | null {
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
