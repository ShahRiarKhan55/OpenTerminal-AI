"use client";

import { useState } from "react";
import { pnlClass } from "../../lib/engine";
import {
  ASSET_TYPE_LABEL, formatAge, formatJst, formatPercent, formatPrice, formatSignedYen, formatUnits, formatYen, jstToday, parseDecimal, priceBadge, priceUnitLabel, toneClass,
  type ValuationDto,
} from "../../lib/investments";

type Props = {
  v: ValuationDto;
  now: number;
  color: string;
  onUpdatePrice: (id: number, price: number, asOf: string) => Promise<void>;
  onEdit: (v: ValuationDto) => void;
  onDelete: (v: ValuationDto) => void;
};

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div>
      <div className="dim text-[9px] uppercase tracking-wider">{k}</div>
      <div className={`text-[13px] font-bold ${cls ?? ""}`}>{v}</div>
    </div>
  );
}

/** One asset: what it is, its current price/NAV with an honest freshness badge, and its value and profit/loss. */
export default function HoldingCard({ v, now, color, onUpdatePrice, onEdit, onDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState("");
  const [asOf, setAsOf] = useState(jstToday());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const badge = priceBadge(v);
  const h = v.holding;

  const priceWhen =
    v.priceKind === "quote"
      ? `${v.priceLabel} · ${formatAge(v.priceTimeMs, now)}`
      : v.priceKind === "manual"
      ? `${v.priceLabel.replace(/^manual /, "")} · entered ${formatJst(h.manualPriceUpdatedAt)}`
      : "no price entered";

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseDecimal(price);
    if (!p.ok || p.value === null) {
      setErr(p.ok ? "enter the new price/NAV" : p.error);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await onUpdatePrice(v.id, p.value, asOf || jstToday());
      setEditing(false);
      setPrice("");
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "could not save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="border border-[var(--border)] bg-[var(--panel)] flex flex-col" style={{ borderTop: `2px solid ${color}` }} aria-label={v.name}>
      <header className="px-3 pt-2 pb-1">
        <div className="flex items-start gap-2">
          <h3 className="font-bold text-[13px] leading-tight break-words min-w-0 flex-1">{v.name}</h3>
          <span className={`text-[10px] font-bold px-1.5 border border-current ${toneClass(badge.tone)}`} title={badge.hint}>{badge.text}</span>
        </div>
        <div className="dim text-[10px]">
          {ASSET_TYPE_LABEL[v.assetType]}
          {v.symbol ? ` · ${v.symbol}` : ""} · {v.currency}
        </div>
      </header>

      <div className="px-3 pb-2">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-lg font-bold">{formatPrice(v.price)}</span>
          <span className="dim text-[10px]">{priceUnitLabel(v.priceUnit)}</span>
        </div>
        <div className={`text-[10px] ${v.priceStatus === "fresh" ? "dim" : toneClass(badge.tone)}`}>{priceWhen}</div>
        {v.quoteIssue && <div className="amber text-[10px] mt-0.5">{v.quoteIssue}</div>}
      </div>

      <div className="px-3 pb-3 grid grid-cols-2 gap-x-3 gap-y-2">
        <Stat k="Units" v={formatUnits(v.units)} />
        <Stat k="Market value" v={v.marketValue === null ? "not valued" : formatYen(v.marketValue)} cls={v.marketValue === null ? "dim" : ""} />
        <Stat k="Cost basis" v={formatYen(v.costBasis)} />
        <Stat
          k="Unrealized P/L"
          v={v.unrealizedPnl === null ? "—" : `${formatSignedYen(v.unrealizedPnl)} (${formatPercent(v.unrealizedPct, true)})`}
          cls={pnlClass(v.unrealizedPnl)}
        />
      </div>

      {editing && (
        <form onSubmit={save} className="px-3 pb-3 grid gap-1 border-t border-[var(--border)] pt-2">
          <div className="dim text-[10px]">New {v.assetType === "crypto" ? "price" : "NAV"} ({priceUnitLabel(v.priceUnit)})</div>
          <div className="flex gap-1 flex-wrap">
            <input aria-label="New price or NAV" className="flex-1 min-w-24" inputMode="decimal" autoFocus placeholder="¥" value={price} onChange={(e) => setPrice(e.target.value)} />
            <input aria-label="Date the price refers to" type="date" value={asOf} max={jstToday()} onChange={(e) => setAsOf(e.target.value)} />
            <button className="term-btn active" type="submit" disabled={busy}>SAVE</button>
            <button className="term-btn" type="button" onClick={() => { setEditing(false); setErr(null); }}>CANCEL</button>
          </div>
          {err && <div className="down text-[10px]" role="alert">{err}</div>}
        </form>
      )}

      <footer className="mt-auto px-3 py-2 border-t border-[var(--border)] flex gap-1 flex-wrap">
        <button className="term-btn" onClick={() => setEditing((x) => !x)}>{v.assetType === "crypto" ? "UPDATE PRICE" : "UPDATE NAV"}</button>
        <button className="term-btn" onClick={() => onEdit(v)}>EDIT</button>
        <button className="term-btn ml-auto hover:!text-[var(--down)] hover:!border-[var(--down)]" onClick={() => onDelete(v)}>DELETE</button>
      </footer>
    </article>
  );
}
