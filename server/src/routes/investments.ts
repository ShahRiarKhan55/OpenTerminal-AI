import { Router } from "express";
import { audit } from "../audit.js";
import { db } from "../db.js";
import { getQuotes } from "../marketdata/quotes.js";
import { DEFAULT_POLICY, jstDateKey, summarize, valueHolding, BASE_CURRENCY, QUOTE_DEADLINE_MS, SUPPORTED_CURRENCIES, ASSET_TYPES, type QuoteReading } from "../investments/calc.js";
import { checkAsOfNotFuture, HoldingInputSchema, PriceUpdateSchema } from "../investments/schema.js";
import { createHolding, deleteHolding, getHolding, HoldingLimitError, listHoldings, setManualPrice, updateHolding } from "../investments/store.js";
import { parseBody, parseId } from "./util.js";

/**
 * Personal investment holdings: manually maintained positions (funds, gold, crypto...) valued in a single base
 * currency. Mounted behind the API key (see app.ts). Nothing here trades or contacts a broker.
 */
export const investmentsRouter = Router();
export const INVESTMENT_PREFIXES = ["/holdings", "/investments"];

investmentsRouter.get("/holdings", (_req, res) => {
  res.json({ holdings: listHoldings(db), baseCurrency: BASE_CURRENCY, supportedCurrencies: SUPPORTED_CURRENCIES, assetTypes: ASSET_TYPES });
});

investmentsRouter.post("/holdings", (req, res) => {
  const body = parseBody(req, res, HoldingInputSchema);
  if (!body) return;
  const now = Date.now();
  const asOf = body.manualPriceAsOf ?? jstDateKey(now);
  const future = body.manualPrice !== null ? checkAsOfNotFuture(asOf, now) : null;
  if (future) return res.status(400).json({ error: `manualPriceAsOf: ${future}` });
  try {
    const h = createHolding(db, body, now, jstDateKey(now));
    audit(db, { kind: "api", decision: "holding_created", detail: { id: h.id, name: h.name, assetType: h.assetType } }, now);
    res.status(201).json(h);
  } catch (e) {
    if (e instanceof HoldingLimitError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

investmentsRouter.put("/holdings/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid holding id" });
  const body = parseBody(req, res, HoldingInputSchema);
  if (!body) return;
  const now = Date.now();
  const future = body.manualPrice !== null && body.manualPriceAsOf ? checkAsOfNotFuture(body.manualPriceAsOf, now) : null;
  if (future) return res.status(400).json({ error: `manualPriceAsOf: ${future}` });
  const h = updateHolding(db, id, body, now, jstDateKey(now));
  if (!h) return res.status(404).json({ error: "holding not found" });
  audit(db, { kind: "api", decision: "holding_updated", detail: { id } }, now);
  res.json(h);
});

investmentsRouter.post("/holdings/:id/price", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid holding id" });
  const body = parseBody(req, res, PriceUpdateSchema);
  if (!body) return;
  const now = Date.now();
  const asOf = body.asOf ?? jstDateKey(now);
  const future = checkAsOfNotFuture(asOf, now);
  if (future) return res.status(400).json({ error: `asOf: ${future}` });
  const h = setManualPrice(db, id, body.price, asOf, now);
  if (!h) return res.status(404).json({ error: "holding not found" });
  audit(db, { kind: "api", decision: "holding_price_set", detail: { id, price: body.price, asOf } }, now);
  res.json(h);
});

investmentsRouter.delete("/holdings/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid holding id" });
  if (!deleteHolding(db, id)) return res.status(404).json({ error: "holding not found" });
  audit(db, { kind: "api", decision: "holding_deleted", detail: { id } }, Date.now());
  res.status(204).end();
});

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`quote lookup exceeded ${ms}ms`)), ms); });
  // The underlying request keeps running (and warms the quote cache for the next refresh); its late result is ignored.
  p.catch(() => undefined);
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** Holdings valued now: live quotes where configured, manual prices otherwise, every price labelled fresh/stale/missing. */
investmentsRouter.get("/investments/summary", async (_req, res) => {
  const now = Date.now();
  const holdings = listHoldings(db);
  const symbols = [...new Set(holdings.filter((h) => h.priceSource === "quote" && h.symbol).map((h) => h.symbol as string))];
  const readings = new Map<string, QuoteReading>();
  let quoteError: string | null = null;
  if (symbols.length > 0) {
    try {
      for (const q of await withDeadline(getQuotes(symbols), QUOTE_DEADLINE_MS)) {
        readings.set(q.symbol.toUpperCase(), {
          symbol: q.symbol,
          price: q.price,
          currency: q.currency,
          timeMs: q.time === null ? null : q.time > 1e11 ? q.time : q.time * 1000,
          source: q.source,
          servedStale: q.servedStale === true,
        });
      }
    } catch (e) {
      quoteError = "live quotes are unavailable right now";
      console.error("[investments] quote fetch failed:", e instanceof Error ? e.message : String(e));
    }
  }
  const valuations = holdings.map((h) => valueHolding(h, h.symbol ? readings.get(h.symbol.toUpperCase()) ?? null : null, now, DEFAULT_POLICY));
  res.json({
    asOf: now,
    baseCurrency: BASE_CURRENCY,
    summary: summarize(valuations, { base: BASE_CURRENCY, nowMs: now }),
    holdings: valuations.map((v) => ({ ...v, holding: holdings.find((h) => h.id === v.id) })),
    quoteError,
  });
});
