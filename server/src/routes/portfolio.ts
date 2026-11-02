import { Router } from "express";
import { z } from "zod";
import { db } from "../db.js";

export const portfolioRouter = Router();

// Route params arrive as strings; reject anything that isn't a positive integer
// before it reaches SQLite (which would otherwise coerce "abc" or "1abc" quietly).
function parseId(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

function portfolioExists(id: number): boolean {
  return Boolean(db.prepare("SELECT 1 FROM portfolios WHERE id = ?").get(id));
}

portfolioRouter.get("/", (_req, res) => {
  res.json(db.prepare("SELECT * FROM portfolios ORDER BY id").all());
});

portfolioRouter.post("/", (req, res) => {
  const parsed = z.object({ name: z.string().min(1).max(64) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  try {
    const info = db.prepare("INSERT INTO portfolios (name) VALUES (?)").run(parsed.data.name);
    res.status(201).json({ id: info.lastInsertRowid, name: parsed.data.name });
  } catch {
    res.status(409).json({ error: "portfolio name already exists" });
  }
});

portfolioRouter.delete("/:id", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid portfolio id" });
  // Transactions go with it via ON DELETE CASCADE (foreign_keys is enabled in db.ts).
  const info = db.prepare("DELETE FROM portfolios WHERE id = ?").run(id);
  if (info.changes === 0) return res.status(404).json({ error: "portfolio not found" });
  res.status(204).end();
});

const txSchema = z.object({
  symbol: z.string().min(1).max(12).transform((s) => s.toUpperCase()),
  side: z.enum(["BUY", "SELL"]),
  quantity: z.number().positive(),
  price: z.number().nonnegative(),
  // Must be a real, parseable date; stored normalized to ISO-8601 UTC so that
  // the ORDER BY executed_at used for average-cost replay sorts chronologically.
  executed_at: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: "executed_at must be a valid date" })
    .transform((v) => new Date(v).toISOString()),
});

portfolioRouter.get("/:id/transactions", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid portfolio id" });
  if (!portfolioExists(id)) return res.status(404).json({ error: "portfolio not found" });
  res.json(
    db
      .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at DESC, id DESC")
      .all(id)
  );
});

portfolioRouter.post("/:id/transactions", (req, res) => {
  const id = parseId(req.params.id);
  if (id === null) return res.status(400).json({ error: "invalid portfolio id" });
  const parsed = txSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
  if (!portfolioExists(id)) return res.status(404).json({ error: "portfolio not found" });
  const t = parsed.data;
  const info = db
    .prepare(
      "INSERT INTO transactions (portfolio_id, symbol, side, quantity, price, executed_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(id, t.symbol, t.side, t.quantity, t.price, t.executed_at);
  res.status(201).json({ id: info.lastInsertRowid, ...t });
});

portfolioRouter.delete("/:id/transactions/:txId", (req, res) => {
  const id = parseId(req.params.id);
  const txId = parseId(req.params.txId);
  if (id === null || txId === null) return res.status(400).json({ error: "invalid id" });
  const info = db.prepare("DELETE FROM transactions WHERE id = ? AND portfolio_id = ?").run(txId, id);
  if (info.changes === 0) return res.status(404).json({ error: "transaction not found" });
  res.status(204).end();
});

/** Aggregated positions with average cost and realized PnL (FIFO-free, average-cost method). */
portfolioRouter.get("/:id/positions", (req, res) => {
  const pid = parseId(req.params.id);
  if (pid === null) return res.status(400).json({ error: "invalid portfolio id" });
  if (!portfolioExists(pid)) return res.status(404).json({ error: "portfolio not found" });
  const txs = db
    .prepare("SELECT * FROM transactions WHERE portfolio_id = ? ORDER BY executed_at, id")
    .all(pid) as Array<{ symbol: string; side: string; quantity: number; price: number }>;

  const positions = new Map<string, { qty: number; avgCost: number; realizedPnl: number }>();
  for (const tx of txs) {
    let p = positions.get(tx.symbol);
    if (!p) {
      p = { qty: 0, avgCost: 0, realizedPnl: 0 };
      positions.set(tx.symbol, p);
    }
    if (tx.side === "BUY") {
      const totalCost = p.avgCost * p.qty + tx.price * tx.quantity;
      p.qty += tx.quantity;
      p.avgCost = p.qty > 0 ? totalCost / p.qty : 0;
    } else {
      const sold = Math.min(tx.quantity, p.qty);
      p.realizedPnl += (tx.price - p.avgCost) * sold;
      p.qty -= sold;
      if (p.qty === 0) p.avgCost = 0;
    }
  }
  res.json(
    [...positions.entries()]
      .filter(([, p]) => p.qty > 0 || p.realizedPnl !== 0)
      .map(([symbol, p]) => ({ symbol, quantity: p.qty, avgCost: p.avgCost, realizedPnl: p.realizedPnl }))
  );
});
