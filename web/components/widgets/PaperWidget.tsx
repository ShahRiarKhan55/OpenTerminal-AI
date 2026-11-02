"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend, fmt } from "../../lib/api";
import { ago, etTime, money, pnlClass, signed, type AccountSummary, type PositionItem } from "../../lib/engine";
import { useTerminal } from "../../store/terminal";

type Tab = "open" | "history";

function Tile({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="border border-[var(--border)] px-2 py-1">
      <div className="dim text-[9px] uppercase tracking-wider">{label}</div>
      <div className={`text-[13px] font-bold ${cls ?? ""}`}>{value}</div>
    </div>
  );
}

export default function PaperWidget() {
  const qc = useQueryClient();
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [tab, setTab] = useState<Tab>("open");
  const [message, setMessage] = useState<string | null>(null);

  const account = useQuery({ queryKey: ["paper-account"], queryFn: () => apiGet<AccountSummary>("/api/paper/account"), refetchInterval: 5_000 });
  const positions = useQuery({
    queryKey: ["paper-positions", tab],
    queryFn: () => apiGet<PositionItem[]>(`/api/paper/positions?status=${tab === "open" ? "open" : "closed"}&limit=100`),
    refetchInterval: 5_000,
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["paper-account"] });
    void qc.invalidateQueries({ queryKey: ["paper-positions"] });
  };
  const close = useMutation({
    mutationFn: (id: number) => apiSend("POST", `/api/paper/positions/${id}/close`),
    onSuccess: () => { setMessage(null); refresh(); },
    onError: (e: Error) => setMessage(e.message),
  });
  const reset = useMutation({
    mutationFn: () => apiSend("POST", "/api/paper/reset", { confirm: "RESET" }),
    onSuccess: () => { setMessage("Paper account reset."); refresh(); },
    onError: (e: Error) => setMessage(e.message),
  });

  const a = account.data;
  const err = (account.error ?? positions.error) as Error | null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-0.5 text-[9px] amber border-b border-[var(--border)]">
        PAPER TRADING · simulated fills on delayed/indicative data · no real orders exist
      </div>
      {err && <div className="p-2 down">Error: {err.message}</div>}
      {a && (
        <div className="grid grid-cols-3 gap-1 p-1">
          <Tile label="Equity" value={money(a.equity)} />
          <Tile label="Day P&L" value={money(a.dailyPnl)} cls={pnlClass(a.dailyPnl)} />
          <Tile label="All-time" value={money(a.allTimePnl)} cls={pnlClass(a.allTimePnl)} />
          <Tile label="Cash" value={money(a.cash)} />
          <Tile label="Open risk" value={money(a.openRisk)} />
          <Tile label="Win rate" value={a.allTime.winRate === null ? "—" : `${Math.round(a.allTime.winRate * 100)}% (${a.allTime.closedTrades})`} />
        </div>
      )}
      {a && !a.limits.tradingEnabled && <div className="px-2 down text-[11px]">Kill switch ON: no new paper entries.</div>}
      {a && (
        <div className="px-2 dim text-[10px]">
          {a.openPositions}/{a.limits.maxOpenPositions} positions · {a.tradesToday}/{a.limits.maxTradesPerDay} trades today · daily loss limit {a.limits.maxDailyLossPct}%
        </div>
      )}

      <div className="flex items-center gap-1 p-1 border-b border-[var(--border)]">
        {(["open", "history"] as Tab[]).map((t) => (
          <button key={t} className={`term-btn ${tab === t ? "amber" : "dim"}`} onClick={() => setTab(t)}>{t.toUpperCase()}</button>
        ))}
        {message && <span className="dim text-[10px] ml-2 truncate">{message}</span>}
        <button
          className="term-btn dim ml-auto"
          onClick={() => {
            if (window.prompt("This deletes ALL paper positions and orders and restores starting cash.\nType RESET to confirm.") === "RESET") reset.mutate();
          }}
        >
          RESET
        </button>
      </div>

      <div className="overflow-auto flex-1">
        {tab === "open" ? (
          <table className="data-table">
            <thead>
              <tr><th>Sym</th><th>Qty</th><th>Entry</th><th>Last</th><th>P&L</th><th>R</th><th>Stop</th><th>Target</th><th></th></tr>
            </thead>
            <tbody>
              {(positions.data ?? []).map((p) => {
                const last = p.last_price ?? p.entry_price;
                const pnl = (last - p.entry_price) * p.qty;
                const r = p.risk_per_share > 0 ? (last - p.entry_price) / p.risk_per_share : null;
                return (
                  <tr key={p.id} onClick={() => setActiveSymbol(p.symbol)} title={`${p.strategy.toUpperCase()} · opened ${etTime(p.opened_at)} ET · price ${p.last_price_at ? ago(p.last_price_at) : "n/a"} old`}>
                    <td className="font-bold">{p.symbol}</td>
                    <td>{p.qty}</td>
                    <td>{fmt(p.entry_price)}</td>
                    <td>{fmt(last)}</td>
                    <td className={pnlClass(pnl)}>{signed(pnl)}</td>
                    <td className={pnlClass(r)}>{r === null ? "—" : signed(r, 2)}</td>
                    <td className="down">{fmt(p.stop_price)}</td>
                    <td className="up">{fmt(p.target_price)}</td>
                    <td>
                      <button
                        className="dim hover:text-[var(--down)]"
                        title="Close this paper position at the last known price"
                        onClick={(e) => { e.stopPropagation(); close.mutate(p.id); }}
                      >
                        close
                      </button>
                    </td>
                  </tr>
                );
              })}
              {positions.data?.length === 0 && (
                <tr><td colSpan={9} className="dim p-3">No open paper positions. Entries happen automatically when a setup passes the risk rules on fresh data.</td></tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Closed</th><th>Sym</th><th>Strategy</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&L</th><th>R</th><th>Why</th></tr>
            </thead>
            <tbody>
              {(positions.data ?? []).map((p) => (
                <tr key={p.id} onClick={() => setActiveSymbol(p.symbol)}>
                  <td className="dim">{p.closed_at ? etTime(p.closed_at) : ""}</td>
                  <td className="font-bold">{p.symbol}</td>
                  <td>{p.strategy.toUpperCase()}</td>
                  <td>{p.qty}</td>
                  <td>{fmt(p.entry_price)}</td>
                  <td>{fmt(p.exit_price)}</td>
                  <td className={pnlClass(p.realized_pnl)}>{signed(p.realized_pnl)}</td>
                  <td className={pnlClass(p.r_multiple)}>{p.r_multiple === null ? "—" : signed(p.r_multiple, 2)}</td>
                  <td className="dim">{(p.exit_reason ?? "").replace("_", " ")}</td>
                </tr>
              ))}
              {positions.data?.length === 0 && <tr><td colSpan={9} className="dim p-3">No closed trades yet.</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
