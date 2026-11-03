import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrations.js";
import { makeDb } from "../test-helpers.js";
import { HoldingInputSchema, type HoldingInput } from "./schema.js";
import { createHolding, deleteHolding, getHolding, HoldingLimitError, listHoldings, MAX_HOLDINGS, setManualPrice, updateHolding } from "./store.js";

const input = (over: Record<string, unknown> = {}): HoldingInput =>
  HoldingInputSchema.parse({ name: "eMAXIS Slim All Country", assetType: "mutual_fund", currency: "JPY", units: 1_000_000, avgPrice: 25_000, priceUnit: 10_000, ...over });
const T0 = Date.UTC(2026, 10, 3, 3, 0, 0);
const TODAY = "2026-11-03";

describe("holdings store: CRUD", () => {
  it("creates a holding and reads it back with every field", () => {
    const db = makeDb();
    const h = createHolding(db, input({ symbol: "x1", notes: "NISA", manualPrice: 28_000, manualPriceAsOf: "2026-11-02" }), T0, TODAY);
    expect(h).toMatchObject({
      id: 1, name: "eMAXIS Slim All Country", assetType: "mutual_fund", symbol: "X1", currency: "JPY", units: 1_000_000, avgPrice: 25_000, priceUnit: 10_000,
      priceSource: "manual", manualPrice: 28_000, manualPriceAsOf: "2026-11-02", manualPriceUpdatedAt: T0, notes: "NISA", createdAt: T0, updatedAt: T0,
    });
    expect(getHolding(db, 1)).toEqual(h);
    expect(listHoldings(db)).toEqual([h]);
  });
  it("a price given without a date is dated 'today'; no price means no price metadata", () => {
    const db = makeDb();
    expect(createHolding(db, input({ manualPrice: 100 }), T0, TODAY)).toMatchObject({ manualPriceAsOf: TODAY, manualPriceUpdatedAt: T0 });
    expect(createHolding(db, input(), T0, TODAY)).toMatchObject({ manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null });
  });
  it("returns holdings in creation order and null for unknown ids", () => {
    const db = makeDb();
    for (const n of ["a", "b", "c"]) createHolding(db, input({ name: n }), T0, TODAY);
    expect(listHoldings(db).map((h) => h.name)).toEqual(["a", "b", "c"]);
    expect(getHolding(db, 99)).toBeNull();
    expect(updateHolding(db, 99, input(), T0, TODAY)).toBeNull();
    expect(setManualPrice(db, 99, 1, TODAY, T0)).toBeNull();
    expect(deleteHolding(db, 99)).toBe(false);
  });

  it("update replaces editable fields, bumps updatedAt, and keeps createdAt", () => {
    const db = makeDb();
    createHolding(db, input({ manualPrice: 28_000, manualPriceAsOf: "2026-11-02" }), T0, TODAY);
    const u = updateHolding(db, 1, input({ name: "Renamed", units: 2_000_000, manualPrice: 28_000, manualPriceAsOf: "2026-11-02" }), T0 + 5000, TODAY)!;
    expect(u).toMatchObject({ name: "Renamed", units: 2_000_000, createdAt: T0, updatedAt: T0 + 5000 });
  });
  it("editing only the units does NOT make an old NAV look freshly entered", () => {
    const db = makeDb();
    createHolding(db, input({ manualPrice: 28_000, manualPriceAsOf: "2026-10-28" }), T0, TODAY);
    const u = updateHolding(db, 1, input({ units: 5, manualPrice: 28_000, manualPriceAsOf: "2026-10-28" }), T0 + 86_400_000, TODAY)!;
    expect(u.manualPriceUpdatedAt).toBe(T0);
  });
  it("changing the price or its date DOES refresh the entry timestamp; clearing the price clears all price metadata", () => {
    const db = makeDb();
    createHolding(db, input({ manualPrice: 28_000, manualPriceAsOf: "2026-11-02" }), T0, TODAY);
    expect(updateHolding(db, 1, input({ manualPrice: 28_100, manualPriceAsOf: "2026-11-02" }), T0 + 1, TODAY)!.manualPriceUpdatedAt).toBe(T0 + 1);
    expect(updateHolding(db, 1, input({ manualPrice: 28_100, manualPriceAsOf: "2026-11-03" }), T0 + 2, TODAY)!.manualPriceUpdatedAt).toBe(T0 + 2);
    expect(updateHolding(db, 1, input(), T0 + 3, TODAY)).toMatchObject({ manualPrice: null, manualPriceAsOf: null, manualPriceUpdatedAt: null });
  });
  it("setManualPrice records the NAV, its date and when it was entered", () => {
    const db = makeDb();
    createHolding(db, input(), T0, TODAY);
    expect(setManualPrice(db, 1, 28_950.5, "2026-11-02", T0 + 9)).toMatchObject({ manualPrice: 28_950.5, manualPriceAsOf: "2026-11-02", manualPriceUpdatedAt: T0 + 9, updatedAt: T0 + 9 });
  });
  it("delete removes only the target", () => {
    const db = makeDb();
    createHolding(db, input({ name: "a" }), T0, TODAY);
    createHolding(db, input({ name: "b" }), T0, TODAY);
    expect(deleteHolding(db, 1)).toBe(true);
    expect(listHoldings(db).map((h) => h.name)).toEqual(["b"]);
  });
  it(`refuses to grow past ${MAX_HOLDINGS} holdings`, () => {
    const db = makeDb();
    for (let i = 0; i < MAX_HOLDINGS; i++) createHolding(db, input({ name: `h${i}` }), T0, TODAY);
    expect(() => createHolding(db, input(), T0, TODAY)).toThrow(HoldingLimitError);
  });
  it("hostile text is stored as inert data (parameterized SQL)", () => {
    const db = makeDb();
    const evil = "Robert'); DROP TABLE holdings;--";
    createHolding(db, input({ name: evil, notes: "<script>alert(1)</script>" }), T0, TODAY);
    expect(listHoldings(db)[0]).toMatchObject({ name: evil, notes: "<script>alert(1)</script>" });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'holdings'").get()).toBeTruthy();
  });
});

describe("database constraints are a second line of defence (bypassing the API)", () => {
  const raw = (db: Database.Database, over: Record<string, unknown>) => {
    const v = { name: "x", asset_type: "stock", symbol: null, currency: "JPY", units: 1, avg_price: 1, price_unit: 1, price_source: "manual", ...over };
    return db.prepare("INSERT INTO holdings (name, asset_type, symbol, currency, units, avg_price, price_unit, price_source, created_at, updated_at) VALUES (@name, @asset_type, @symbol, @currency, @units, @avg_price, @price_unit, @price_source, 0, 0)").run(v);
  };
  it.each([
    ["negative units", { units: -1 }],
    ["negative average price", { avg_price: -1 }],
    ["an unknown asset type", { asset_type: "nft" }],
    ["a lower-case currency", { currency: "jpy" }],
    ["a 2-letter currency", { currency: "JP" }],
    ["a price unit of 7", { price_unit: 7 }],
    ["an unknown price source", { price_source: "scraper" }],
  ])("rejects %s", (_n, over) => {
    expect(() => raw(makeDb(), over)).toThrow(/CHECK constraint/);
  });
  it("accepts a valid row (control)", () => {
    expect(() => raw(makeDb(), {})).not.toThrow();
  });
});

describe("persistence: data survives closing and reopening the database file", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("holdings, exact fractional units and price metadata are all still there after a restart", () => {
    dir = mkdtempSync(join(tmpdir(), "ot-holdings-"));
    const file = join(dir, "terminal.db");
    const open = () => {
      const d = new Database(file);
      d.pragma("journal_mode = WAL");
      d.pragma("foreign_keys = ON");
      runMigrations(d);
      return d;
    };

    const first = open();
    createHolding(first, input({ manualPrice: 28_345.67, manualPriceAsOf: "2026-11-02" }), T0, TODAY);
    createHolding(first, input({ name: "Bitcoin", assetType: "crypto", symbol: "btc-jpy", priceUnit: 1, priceSource: "quote", units: 0.01234567, avgPrice: 11_234_567.89 }), T0 + 1, TODAY);
    createHolding(first, input({ name: "Gold Fund", assetType: "commodity_fund", units: 123_456, avgPrice: 18_900, manualPrice: 19_100, manualPriceAsOf: "2026-11-03" }), T0 + 2, TODAY);
    const before = listHoldings(first);
    first.close(); // "application restart"

    const second = open();
    const after = listHoldings(second);
    expect(after).toEqual(before);
    expect(after).toHaveLength(3);
    expect(after[1]).toMatchObject({ symbol: "BTC-JPY", units: 0.01234567, avgPrice: 11_234_567.89, priceSource: "quote" });
    expect(after[0]).toMatchObject({ manualPrice: 28_345.67, manualPriceAsOf: "2026-11-02", manualPriceUpdatedAt: T0, priceUnit: 10_000 });

    // and edits made after the restart persist across the next one
    updateHolding(second, after[2].id, input({ name: "Gold Fund", assetType: "commodity_fund", units: 200_000, avgPrice: 18_900, manualPrice: 19_100, manualPriceAsOf: "2026-11-03" }), T0 + 9, TODAY);
    deleteHolding(second, after[1].id);
    second.close();
    const third = open();
    expect(listHoldings(third).map((h) => [h.name, h.units])).toEqual([["eMAXIS Slim All Country", 1_000_000], ["Gold Fund", 200_000]]);
    third.close();
  });

  it("a restored backup brings the holdings back", async () => {
    dir = mkdtempSync(join(tmpdir(), "ot-holdings-bk-"));
    const { createBackup, restoreBackup } = await import("../backup.js");
    const file = join(dir, "terminal.db");
    const live = new Database(file);
    live.pragma("journal_mode = WAL");
    runMigrations(live);
    createHolding(live, input({ manualPrice: 28_000, manualPriceAsOf: "2026-11-02" }), T0, TODAY);
    const bk = createBackup({ dbFile: file, dir: join(dir, "backups") });
    createHolding(live, input({ name: "added after backup" }), T0 + 1, TODAY);
    live.close();
    restoreBackup({ dataDir: dir, backupFile: bk.path, confirmedStopped: true });
    const restored = new Database(file, { readonly: true });
    expect((restored.prepare("SELECT name FROM holdings").all() as { name: string }[]).map((r) => r.name)).toEqual(["eMAXIS Slim All Country"]);
    restored.close();
  });
});
