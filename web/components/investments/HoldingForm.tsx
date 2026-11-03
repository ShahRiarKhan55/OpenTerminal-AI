"use client";

import { useState } from "react";
import {
  ASSET_TYPES, ASSET_TYPE_LABEL, buildHoldingPayload, defaultPriceUnit, formatYen, parseDecimal, PRESETS, type AssetType, type FormState, type PriceUnit,
} from "../../lib/investments";

type Props = {
  mode: "add" | "edit";
  initial: FormState;
  /** Resolves on success; rejects with the server's message, which is shown in the form. */
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
};

const label = "block text-[10px] uppercase tracking-wider dim mb-0.5";
const fieldErr = "down text-[10px] mt-0.5";

/** Add / edit a holding. Numbers are typed as text so full-width digits, commas and a yen sign work. */
export default function HoldingForm({ mode, initial, onSubmit, onClose }: Props) {
  const [f, setF] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((p) => ({ ...p, [k]: v }));

  // Live preview using the same formula the server uses, so a wrong NAV basis is obvious before saving.
  const units = parseDecimal(f.units);
  const avg = parseDecimal(f.avgPrice);
  const price = parseDecimal(f.manualPrice);
  const cost = units.ok && avg.ok && units.value !== null && avg.value !== null ? (units.value * avg.value) / f.priceUnit : null;
  const value = units.ok && price.ok && units.value !== null && price.value !== null ? (units.value * price.value) / f.priceUnit : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);
    const r = buildHoldingPayload(f);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await onSubmit(r.body);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "could not save");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 overflow-auto p-3 flex items-start justify-center" onClick={onClose} role="dialog" aria-modal="true" aria-label={mode === "add" ? "Add holding" : "Edit holding"}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-2xl bg-[var(--panel)] border border-[var(--amber-dim)] my-6">
        <div className="flex items-center px-3 py-2 border-b border-[var(--border)]">
          <span className="amber font-bold tracking-widest text-[11px] uppercase">{mode === "add" ? "Add holding" : "Edit holding"}</span>
          <button type="button" className="ml-auto dim hover:text-[var(--down)]" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="p-3 grid gap-3">
          {mode === "add" && (
            <div>
              <span className={label}>Quick start</span>
              <div className="flex flex-wrap gap-1">
                {PRESETS.map((p) => (
                  <button type="button" key={p.id} className="term-btn" onClick={() => setF((prev) => ({ ...prev, ...p.form }))}>
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="dim text-[10px] mt-1">Fills in the name, type and price basis. You enter the amounts.</div>
            </div>
          )}

          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={label} htmlFor="hf-name">Name</label>
              <input id="hf-name" className="w-full" value={f.name} onChange={(e) => set("name", e.target.value)} maxLength={80} />
              {errors.name && <div className={fieldErr}>{errors.name}</div>}
            </div>

            <div>
              <label className={label} htmlFor="hf-type">Asset type</label>
              <select
                id="hf-type"
                className="w-full"
                value={f.assetType}
                onChange={(e) => {
                  const t = e.target.value as AssetType;
                  setF((p) => ({ ...p, assetType: t, ...(mode === "add" ? { priceUnit: defaultPriceUnit(t) } : {}) }));
                }}
              >
                {ASSET_TYPES.map((t) => (
                  <option key={t} value={t}>{ASSET_TYPE_LABEL[t]}</option>
                ))}
              </select>
            </div>

            <div>
              <label className={label} htmlFor="hf-ccy">Currency</label>
              <select id="hf-ccy" className="w-full" value="JPY" disabled onChange={() => {}}>
                <option value="JPY">JPY (portfolio base currency)</option>
              </select>
              <div className="dim text-[10px] mt-0.5">Other currencies are not supported yet, so totals can never mix currencies.</div>
            </div>

            <div>
              <label className={label} htmlFor="hf-units">Units held</label>
              <input id="hf-units" className="w-full" inputMode="decimal" placeholder="e.g. 1,234,567 or 0.0123" value={f.units} onChange={(e) => set("units", e.target.value)} />
              {errors.units && <div className={fieldErr}>{errors.units}</div>}
            </div>

            <div>
              <label className={label} htmlFor="hf-avg">Average purchase price (¥)</label>
              <input id="hf-avg" className="w-full" inputMode="decimal" placeholder="your average cost, same basis as below" value={f.avgPrice} onChange={(e) => set("avgPrice", e.target.value)} />
              {errors.avgPrice && <div className={fieldErr}>{errors.avgPrice}</div>}
            </div>

            <div className="sm:col-span-2">
              <label className={label} htmlFor="hf-basis">Prices are quoted</label>
              <select id="hf-basis" className="w-full" value={f.priceUnit} onChange={(e) => set("priceUnit", Number(e.target.value) as PriceUnit)}>
                <option value={10000}>per 10,000 units (Japanese fund NAV / 基準価額)</option>
                <option value={1}>per 1 unit (stocks, ETFs, crypto)</option>
              </select>
              <div className="dim text-[10px] mt-0.5">
                Applies to the purchase price and the current price. Market value = units × price ÷ {f.priceUnit.toLocaleString("en-US")}.
              </div>
            </div>

            <div>
              <label className={label} htmlFor="hf-src">Current price source</label>
              <select id="hf-src" className="w-full" value={f.priceSource} onChange={(e) => set("priceSource", e.target.value as FormState["priceSource"])}>
                <option value="manual">Manual entry (NAV / price I type in)</option>
                <option value="quote">Live quote (with manual fallback)</option>
              </select>
            </div>

            <div>
              <label className={label} htmlFor="hf-sym">Symbol {f.priceSource === "quote" ? "(required)" : "(optional)"}</label>
              <input id="hf-sym" className="w-full" placeholder="e.g. BTC-JPY" value={f.symbol} onChange={(e) => set("symbol", e.target.value)} maxLength={24} />
              {errors.symbol && <div className={fieldErr}>{errors.symbol}</div>}
            </div>

            <div>
              <label className={label} htmlFor="hf-price">Current price / NAV (¥)</label>
              <input id="hf-price" className="w-full" inputMode="decimal" placeholder={f.priceSource === "quote" ? "optional fallback" : "enter the latest NAV"} value={f.manualPrice} onChange={(e) => set("manualPrice", e.target.value)} />
              {errors.manualPrice && <div className={fieldErr}>{errors.manualPrice}</div>}
            </div>

            <div>
              <label className={label} htmlFor="hf-asof">Price / NAV date</label>
              <input id="hf-asof" className="w-full" type="date" value={f.manualPriceAsOf} onChange={(e) => set("manualPriceAsOf", e.target.value)} />
              <div className="dim text-[10px] mt-0.5">The date the NAV refers to. Leave blank for today.</div>
              {errors.manualPriceAsOf && <div className={fieldErr}>{errors.manualPriceAsOf}</div>}
            </div>

            <div className="sm:col-span-2">
              <label className={label} htmlFor="hf-notes">Notes (optional)</label>
              <input id="hf-notes" className="w-full" value={f.notes} onChange={(e) => set("notes", e.target.value)} maxLength={500} />
            </div>
          </div>

          <div className="border border-[var(--border)] px-2 py-1.5 text-[11px]" aria-live="polite">
            <span className="dim">Preview:</span> cost basis <span className="amber">{formatYen(cost)}</span> · market value <span className="amber">{formatYen(value)}</span>
            <span className="dim"> (the server recalculates on save)</span>
          </div>

          {serverError && <div className="down text-[11px]" role="alert">{serverError}</div>}
        </div>

        <div className="flex gap-2 justify-end px-3 py-2 border-t border-[var(--border)]">
          <button type="button" className="term-btn" onClick={onClose}>CANCEL</button>
          <button type="submit" className="term-btn active" disabled={busy}>{busy ? "SAVING…" : mode === "add" ? "ADD HOLDING" : "SAVE CHANGES"}</button>
        </div>
      </form>
    </div>
  );
}
