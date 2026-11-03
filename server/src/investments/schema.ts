import { z } from "zod";
import { ASSET_TYPES, jstDateKey, SUPPORTED_CURRENCIES } from "./calc.js";

const MAX_AMOUNT = 1e12;

/** YYYY-MM-DD that is a real calendar date (rejects 2026-02-30 and the like). */
export const DateKeySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date like 2026-11-02")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "must be a real calendar date");

const money = (what: string) => z.number({ error: `${what} must be a number` }).min(0, `${what} cannot be negative`).max(MAX_AMOUNT, `${what} is unreasonably large`);

/** What the user may set on a holding. Strict: unknown fields are rejected, never silently stored. */
export const HoldingInputSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(80),
    assetType: z.enum(ASSET_TYPES),
    symbol: z
      .string()
      .trim()
      .max(24)
      .regex(/^[A-Za-z0-9.\-=^]*$/, "symbol may contain letters, digits and . - = ^ only")
      .nullish()
      .transform((v) => (v ? v.toUpperCase() : null)),
    currency: z.enum(SUPPORTED_CURRENCIES, { error: `currency must be one of: ${SUPPORTED_CURRENCIES.join(", ")}` }),
    units: money("units"),
    avgPrice: money("average purchase price"),
    priceUnit: z.union([z.literal(1), z.literal(10_000)], { error: "priceUnit must be 1 or 10000" }).default(1),
    priceSource: z.enum(["manual", "quote"]).default("manual"),
    manualPrice: money("price/NAV").nullish().transform((v) => v ?? null),
    manualPriceAsOf: DateKeySchema.nullish().transform((v) => v ?? null),
    notes: z.string().trim().max(500).nullish().transform((v) => v || null),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.priceSource === "quote" && !v.symbol) ctx.addIssue({ code: "custom", path: ["symbol"], message: "a symbol is required for live quotes" });
    if (v.manualPriceAsOf && v.manualPrice === null) ctx.addIssue({ code: "custom", path: ["manualPrice"], message: "manualPriceAsOf was given without a price" });
  });

export type HoldingInput = z.infer<typeof HoldingInputSchema>;

export const PriceUpdateSchema = z.object({ price: money("price/NAV"), asOf: DateKeySchema.optional() }).strict();

/** A NAV date may not be (meaningfully) in the future: at most today in Japan time. */
export function checkAsOfNotFuture(asOf: string, nowMs: number): string | null {
  return asOf > jstDateKey(nowMs) ? "the NAV date cannot be in the future" : null;
}
