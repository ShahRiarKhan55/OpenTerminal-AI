"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend, fmt } from "../../lib/api";
import { ago, etTime, IMPORTANCE_COLOR, SIGNAL_STATUS_CLASS, type AlertItem, type AlertsResponse, type SignalItem } from "../../lib/engine";
import { useTerminal } from "../../store/terminal";

type Tab = "alerts" | "signals";

export default function AlertsWidget() {
  const qc = useQueryClient();
  const setActiveSymbol = useTerminal((s) => s.setActiveSymbol);
  const [tab, setTab] = useState<Tab>("alerts");
  const [all, setAll] = useState(false);

  const alerts = useQuery({
    queryKey: ["alerts", all],
    queryFn: () => apiGet<AlertsResponse>(`/api/alerts?limit=60${all ? "" : "&importance=normal"}`),
    refetchInterval: 5_000,
    enabled: tab === "alerts",
  });
  // "important" = normal + high: the API filters on one level, so fetch both and merge when not showing everything.
  const high = useQuery({
    queryKey: ["alerts-high"],
    queryFn: () => apiGet<AlertsResponse>("/api/alerts?limit=60&importance=high"),
    refetchInterval: 5_000,
    enabled: tab === "alerts" && !all,
  });
  const signals = useQuery({
    queryKey: ["signals"],
    queryFn: () => apiGet<SignalItem[]>("/api/signals?limit=50"),
    refetchInterval: 5_000,
    enabled: tab === "signals",
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["alerts"] });
    void qc.invalidateQueries({ queryKey: ["alerts-high"] });
    void qc.invalidateQueries({ queryKey: ["alerts-badge"] });
  };
  const ack = useMutation({ mutationFn: (id: number) => apiSend("POST", `/api/alerts/${id}/ack`), onSuccess: refresh });
  const ackAll = useMutation({ mutationFn: () => apiSend("POST", "/api/alerts/ack-all"), onSuccess: refresh });

  const list: AlertItem[] = all
    ? alerts.data?.alerts ?? []
    : [...(alerts.data?.alerts ?? []), ...(high.data?.alerts ?? [])].sort((a, b) => b.id - a.id);
  const unread = alerts.data?.unacknowledgedImportant ?? 0;
  const err = (tab === "alerts" ? alerts.error : signals.error) as Error | null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 p-1 border-b border-[var(--border)]">
        {(["alerts", "signals"] as Tab[]).map((t) => (
          <button key={t} className={`term-btn ${tab === t ? "amber" : "dim"}`} onClick={() => setTab(t)}>
            {t.toUpperCase()}
            {t === "alerts" && unread > 0 ? ` (${unread})` : ""}
          </button>
        ))}
        {tab === "alerts" && (
          <>
            <button className="term-btn dim ml-auto" onClick={() => setAll((v) => !v)} title="Include low-importance items such as news and RSI extremes">
              {all ? "ALL" : "IMPORTANT"}
            </button>
            <button className="term-btn dim" onClick={() => ackAll.mutate()} disabled={unread === 0}>
              ACK ALL
            </button>
          </>
        )}
      </div>

      {err && <div className="p-2 down">Error: {err.message}</div>}

      {tab === "alerts" && (
        <div className="overflow-auto flex-1">
          {list.length === 0 && !alerts.isLoading && (
            <div className="p-3 dim">
              No alerts yet. Alerts appear when the monitor detects a setup or event on your watchlist during market hours. Delayed or stale data never produces one.
            </div>
          )}
          {list.map((a) => (
            <div key={a.id} className="flex gap-2 px-2 py-1.5 border-b border-[#161616]" style={{ opacity: a.acknowledged_at ? 0.55 : 1 }}>
              <div style={{ background: IMPORTANCE_COLOR[a.importance], width: 3 }} className="shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="dim text-[10px]" title={new Date(a.created_at).toISOString()}>{etTime(a.created_at)} ET · {ago(a.created_at)}</span>
                  {a.symbol && (
                    <button className="amber font-bold text-[11px]" onClick={() => setActiveSymbol(a.symbol!)}>
                      {a.symbol}
                    </button>
                  )}
                  <span className="font-bold text-[11px] truncate">{a.title}</span>
                  {!a.acknowledged_at && (
                    <button className="dim hover:text-[var(--up)] ml-auto" title="Acknowledge" onClick={() => ack.mutate(a.id)}>
                      ✓
                    </button>
                  )}
                </div>
                <div className="dim text-[11px]">{a.body}</div>
                {a.ai_analysis && (
                  <div className="text-[11px] mt-0.5" style={{ color: "var(--amber)" }}>
                    <span className="font-bold">AI </span>
                    {a.ai_analysis}
                  </div>
                )}
                {a.data_label && <div className="dim text-[9px] mt-0.5">data: {a.data_label}</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === "signals" && (
        <div className="overflow-auto flex-1">
          <table className="data-table">
            <thead>
              <tr><th>Time</th><th>Sym</th><th>Strategy</th><th>Status</th><th>Entry</th><th>Stop</th><th>Target</th><th>R:R</th></tr>
            </thead>
            <tbody>
              {(signals.data ?? []).map((s) => (
                <tr key={s.id} onClick={() => setActiveSymbol(s.symbol)} title={s.reason ?? undefined}>
                  <td className="dim">{etTime(s.created_at)}</td>
                  <td className="font-bold">{s.symbol}</td>
                  <td>{s.strategy.toUpperCase()}</td>
                  <td className={SIGNAL_STATUS_CLASS[s.status]}>{s.status.replace("_", " ")}</td>
                  <td>{fmt(s.entry)}</td>
                  <td>{fmt(s.stop)}</td>
                  <td>{fmt(s.target)}</td>
                  <td>{fmt(s.reward_risk, 1)}</td>
                </tr>
              ))}
              {signals.data?.length === 0 && (
                <tr><td colSpan={8} className="dim p-3">No signals yet. Setups that fail the risk rules appear here as "blocked" with the reason on hover.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
