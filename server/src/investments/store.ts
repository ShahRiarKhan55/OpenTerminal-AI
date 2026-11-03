import type Database from "better-sqlite3";
import type { AssetType, Holding, PriceSource, PriceUnit } from "./calc.js";
import type { HoldingInput } from "./schema.js";

export const MAX_HOLDINGS = 200;

type Row = {
  id: number; name: string; asset_type: AssetType; symbol: string | null; currency: string; units: number; avg_price: number;
  price_unit: PriceUnit; price_source: PriceSource; manual_price: number | null; manual_price_as_of: string | null;
  manual_price_updated_at: number | null; notes: string | null; created_at: number; updated_at: number;
};

const toHolding = (r: Row): Holding => ({
  id: r.id, name: r.name, assetType: r.asset_type, symbol: r.symbol, currency: r.currency, units: r.units, avgPrice: r.avg_price,
  priceUnit: r.price_unit, priceSource: r.price_source, manualPrice: r.manual_price, manualPriceAsOf: r.manual_price_as_of,
  manualPriceUpdatedAt: r.manual_price_updated_at, notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listHoldings(db: Database.Database): Holding[] {
  return (db.prepare("SELECT * FROM holdings ORDER BY id").all() as Row[]).map(toHolding);
}

export function getHolding(db: Database.Database, id: number): Holding | null {
  const r = db.prepare("SELECT * FROM holdings WHERE id = ?").get(id) as Row | undefined;
  return r ? toHolding(r) : null;
}

export class HoldingLimitError extends Error {
  constructor() {
    super(`a portfolio can hold at most ${MAX_HOLDINGS} holdings`);
  }
}

/** `asOfDefault` (today in Japan) is used when a price is given without a date. */
export function createHolding(db: Database.Database, input: HoldingInput, nowMs: number, asOfDefault: string): Holding {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM holdings").get() as { c: number }).c;
  if (count >= MAX_HOLDINGS) throw new HoldingLimitError();
  const hasPrice = input.manualPrice !== null;
  const info = db
    .prepare(
      `INSERT INTO holdings (name, asset_type, symbol, currency, units, avg_price, price_unit, price_source, manual_price,
         manual_price_as_of, manual_price_updated_at, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.name, input.assetType, input.symbol, input.currency, input.units, input.avgPrice, input.priceUnit, input.priceSource,
      input.manualPrice, hasPrice ? input.manualPriceAsOf ?? asOfDefault : null, hasPrice ? nowMs : null, input.notes, nowMs, nowMs
    );
  return getHolding(db, Number(info.lastInsertRowid))!;
}

/**
 * Replace a holding's editable fields. The "price entered at" timestamp only moves when the price or its date
 * actually changes, so merely editing the units never makes an old NAV look freshly entered.
 */
export function updateHolding(db: Database.Database, id: number, input: HoldingInput, nowMs: number, asOfDefault: string): Holding | null {
  const cur = getHolding(db, id);
  if (!cur) return null;
  let price = input.manualPrice;
  let asOf = price === null ? null : input.manualPriceAsOf ?? cur.manualPriceAsOf ?? asOfDefault;
  let updatedAt: number | null = price === null ? null : cur.manualPriceUpdatedAt;
  if (price !== null && (price !== cur.manualPrice || asOf !== cur.manualPriceAsOf || updatedAt === null)) updatedAt = nowMs;
  if (price === null) {
    price = null;
    asOf = null;
    updatedAt = null;
  }
  db.prepare(
    `UPDATE holdings SET name = ?, asset_type = ?, symbol = ?, currency = ?, units = ?, avg_price = ?, price_unit = ?, price_source = ?,
       manual_price = ?, manual_price_as_of = ?, manual_price_updated_at = ?, notes = ?, updated_at = ? WHERE id = ?`
  ).run(input.name, input.assetType, input.symbol, input.currency, input.units, input.avgPrice, input.priceUnit, input.priceSource, price, asOf, updatedAt, input.notes, nowMs, id);
  return getHolding(db, id);
}

export function setManualPrice(db: Database.Database, id: number, price: number, asOf: string, nowMs: number): Holding | null {
  const info = db
    .prepare("UPDATE holdings SET manual_price = ?, manual_price_as_of = ?, manual_price_updated_at = ?, updated_at = ? WHERE id = ?")
    .run(price, asOf, nowMs, nowMs, id);
  return info.changes ? getHolding(db, id) : null;
}

export function deleteHolding(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM holdings WHERE id = ?").run(id).changes > 0;
}
