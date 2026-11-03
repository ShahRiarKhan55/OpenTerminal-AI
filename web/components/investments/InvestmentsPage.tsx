"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { apiGet, apiSend } from "../../lib/api";
import { pnlClass } from "../../lib/engine";
import {
  EMPTY_FORM, formatAge, formatJst, formatPercent, formatSignedYen, formatYen, formFromHolding, PRESETS, type FormState, type InvestmentsResponse, type ValuationDto,
} from "../../lib/investments";
import TopBar from "../TopBar";
import AllocationBar, { ALLOCATION_COLORS } from "./AllocationBar";
import HoldingCard from "./HoldingCard";
import HoldingForm from "./HoldingForm";

type FormTarget = { mode: "add"; initial: FormState } | { mode: "edit"; id: number; initial: FormState };

function SummaryCard({ title, value, sub, cls, note }: { title: string; value: string; sub?: string; cls?: string; note?: string }) {
  return (
    <div className="border border-[var(--border)] bg-[var(--panel)] px-3 py-2 min-w-0">
      <div className="dim text-[10px] uppercase tracking-wider">{title}</div>
      <div className={`text-xl font-bold break-words ${cls ?? ""}`}>{value}</div>
      {sub && <div className={`text-[11px] ${cls ?? "dim"}`}>{sub}</div>}
      {note && <div className="amber text-[10px] mt-0.5">{note}</div>}
    </div>
  );
}

export default function InvestmentsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<FormTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["investments-summary"],
    queryFn: () => apiGet<InvestmentsResponse>("/api/investments/summary"),
    refetchInterval: 30_000, // keeps a live BTC quote moving; manual NAVs only change when you update them
    refetchOnWindowFocus: true,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["investments-summary"] });

  const save = useMutation({
    mutationFn: async (args: { id?: number; body: Record<string, unknown> }) =>
      args.id ? apiSend("PUT", `/api/holdings/${args.id}`, args.body) : apiSend("POST", "/api/holdings", args.body),
    onSuccess: refresh,
  });
  const setPrice = useMutation({
    mutationFn: (a: { id: number; price: number; asOf: string }) => apiSend("POST", `/api/holdings/${a.id}/price`, { price: a.price, asOf: a.asOf }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: number) => apiSend("DELETE", `/api/holdings/${id}`), onSuccess: refresh });

  const holdings = data?.holdings ?? [];
  const s = data?.summary;
  const colorOf = useMemo(() => {
    const ids = holdings.map((h) => h.id);
    return (id: number) => ALLOCATION_COLORS[Math.max(0, ids.indexOf(id)) % ALLOCATION_COLORS.length];
  }, [holdings]);

  const openAdd = (preset?: Partial<FormState>) => setForm({ mode: "add", initial: { ...EMPTY_FORM, ...preset } });
  const onDelete = (v: ValuationDto) => {
    if (window.confirm(`Delete "${v.name}" from your portfolio?\nThis removes the holding and its price. It cannot be undone.`)) {
      setActionError(null);
      remove.mutate(v.id, { onError: (e) => setActionError((e as Error).message) });
    }
  };

  return (
    <div className="flex flex-col min-h-screen">
      <TopBar showSearch={false} />
      <main className="flex-1 p-3 max-w-7xl w-full mx-auto grid gap-3 content-start" aria-live="polite">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="amber font-bold tracking-widest uppercase text-sm">My portfolio</h1>
          <span className="dim text-[11px]">base currency JPY</span>
          <div className="ml-auto flex items-center gap-2 flex-wrap">
            {data && (
              <span className="dim text-[10px]" title="When this page last asked the server to value your holdings">
                valued {formatJst(data.asOf)} · {formatAge(data.asOf, now)}
              </span>
            )}
            <button className="term-btn" onClick={() => refetch()} disabled={isFetching}>{isFetching ? "REFRESHING…" : "REFRESH"}</button>
            <button className="term-btn active" onClick={() => openAdd()}>+ ADD HOLDING</button>
          </div>
        </div>

        {isLoading && <div className="dim">Loading your portfolio…</div>}
        {error && (
          <div className="down border border-[var(--down)] px-3 py-2" role="alert">
            Could not load the portfolio: {(error as Error).message}. Check that the API is running.
          </div>
        )}
        {actionError && <div className="down text-[11px]" role="alert">{actionError}</div>}

        {data && s && (
          <>
            {(s.warnings.length > 0 || data.quoteError) && (
              <div className="border border-[var(--amber-dim)] bg-[#1a1408] px-3 py-2 text-[11px]" role="status">
                <div className="amber font-bold mb-0.5">Check before relying on these numbers</div>
                <ul className="list-disc pl-4 grid gap-0.5">
                  {s.warnings.map((w) => <li key={w}>{w}</li>)}
                  {data.quoteError && <li>Live quotes are unavailable right now. Holdings fall back to the last manual price you entered, and are marked accordingly.</li>}
                  {s.excluded.map((x) => <li key={x.id}>{x.name}: {x.reason}</li>)}
                </ul>
              </div>
            )}

            <section aria-label="Portfolio summary" className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <SummaryCard
                title="Total market value"
                value={s.pricedCount === 0 ? "—" : formatYen(s.marketValue)}
                sub={`${s.pricedCount} of ${s.pricedCount + s.missingCount} holding${s.pricedCount + s.missingCount === 1 ? "" : "s"} priced`}
                note={!s.complete ? "Incomplete: some holdings have no price" : s.hasStale ? "Includes stale prices" : undefined}
              />
              <SummaryCard title="Total invested (cost)" value={formatYen(s.totalCost)} sub="all holdings, at your average purchase price" />
              <SummaryCard
                title="Unrealized profit / loss"
                value={s.pricedCount === 0 ? "—" : formatSignedYen(s.unrealizedPnl)}
                sub={s.pricedCount === 0 ? undefined : formatPercent(s.unrealizedPct, true)}
                cls={s.pricedCount === 0 ? "dim" : pnlClass(s.unrealizedPnl)}
                note={s.missingCount > 0 ? "Priced holdings only" : undefined}
              />
              <SummaryCard title="Holdings" value={String(holdings.length)} sub={s.staleCount ? `${s.staleCount} stale · ${s.missingCount} unpriced` : `${s.missingCount} unpriced`} />
            </section>

            {holdings.length === 0 ? (
              <section className="border border-[var(--border)] bg-[var(--panel)] p-4 grid gap-3" aria-label="Get started">
                <div className="amber font-bold">Add your first holding</div>
                <p className="dim text-[12px] max-w-2xl">
                  Funds such as eMAXIS Slim All Country have no free live feed, so you enter the NAV (基準価額) yourself whenever you check it. Bitcoin can use a live BTC-JPY quote,
                  with manual entry as a fallback. Pick a starting point:
                </p>
                <div className="flex flex-wrap gap-2">
                  {PRESETS.map((p) => (
                    <button key={p.id} className="term-btn" onClick={() => openAdd(p.form)}>+ {p.label}</button>
                  ))}
                </div>
              </section>
            ) : (
              <>
                <section aria-label="Allocation" className="border border-[var(--border)] bg-[var(--panel)] p-3">
                  <div className="amber font-bold uppercase tracking-wider text-[11px] mb-2">Allocation by market value</div>
                  <AllocationBar allocation={s.allocation} colorOf={colorOf} />
                </section>

                <section aria-label="Holdings" className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                  {holdings.map((v) => (
                    <HoldingCard
                      key={v.id}
                      v={v}
                      now={now}
                      color={colorOf(v.id)}
                      onUpdatePrice={async (id, price, asOf) => {
                        await setPrice.mutateAsync({ id, price, asOf });
                      }}
                      onEdit={(x) => setForm({ mode: "edit", id: x.id, initial: formFromHolding(x.holding) })}
                      onDelete={onDelete}
                    />
                  ))}
                </section>
              </>
            )}
          </>
        )}

        <footer className="dim text-[10px] pb-4 max-w-3xl">
          Values use the prices you enter and delayed/indicative public quotes; they are not official valuations and this is not investment advice. A missing price is never
          estimated, a stale price is always labelled, and nothing here connects to a broker or places orders.
        </footer>
      </main>

      {form && (
        <HoldingForm
          mode={form.mode}
          initial={form.initial}
          onClose={() => setForm(null)}
          onSubmit={async (body) => {
            await save.mutateAsync({ id: form.mode === "edit" ? form.id : undefined, body });
            setForm(null);
          }}
        />
      )}
    </div>
  );
}
