"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiGet, apiSend, fmt } from "../../lib/api";
import { ago, REGIME_LABEL, type MonitorStatus, type ReportFull, type ReportListItem, type RiskConfig } from "../../lib/engine";

type Tab = "status" | "risk" | "reports";

function Row({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="flex justify-between border-b border-[#161616] py-0.5">
      <span className="dim">{k}</span>
      <span className={cls}>{v}</span>
    </div>
  );
}

const RISK_FIELDS: Array<{ key: keyof RiskConfig & string; label: string; step: number }> = [
  { key: "riskPerTradePct", label: "Risk per trade %", step: 0.05 },
  { key: "maxPositionPct", label: "Max position % of equity", step: 1 },
  { key: "maxOpenPositions", label: "Max open positions", step: 1 },
  { key: "maxTradesPerDay", label: "Max trades / day", step: 1 },
  { key: "maxDailyLossPct", label: "Daily loss limit %", step: 0.25 },
  { key: "minRewardRisk", label: "Min reward : risk", step: 0.1 },
];

function RiskEditor({ status }: { status: MonitorStatus }) {
  const qc = useQueryClient();
  const cfg = status.risk.config;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (patch: Record<string, number | boolean>) => apiSend("PUT", "/api/risk/config", patch),
    onSuccess: () => { setDraft({}); setMsg("Saved. The worker applies it on its next cycle."); void qc.invalidateQueries({ queryKey: ["monitor-status"] }); },
    onError: (e: Error) => setMsg(e.message),
  });
  const dirty = Object.keys(draft).length > 0;

  return (
    <div className="p-2 text-[11px]">
      <div className="flex items-center gap-2 mb-2">
        <button
          className={`term-btn ${cfg.tradingEnabled ? "up" : "down"}`}
          onClick={() => save.mutate({ tradingEnabled: !cfg.tradingEnabled })}
          title="Kill switch: when off, no new paper entries are opened (alerts continue)"
        >
          PAPER ENTRIES: {cfg.tradingEnabled ? "ON" : "OFF"}
        </button>
        <span className="dim">flat by {cfg.flatBy} ET · entries {cfg.entryStart}–{cfg.entryEnd}</span>
      </div>
      {RISK_FIELDS.map((f) => (
        <label key={f.key} className="flex justify-between items-center border-b border-[#161616] py-0.5">
          <span className="dim">{f.label}</span>
          <input
            type="number"
            step={f.step}
            className="w-20 text-right"
            value={draft[f.key] ?? String(cfg[f.key])}
            onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
          />
        </label>
      ))}
      <div className="flex items-center gap-2 mt-2">
        <button
          className="term-btn"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, Number(v)])))}
        >
          SAVE
        </button>
        {dirty && <button className="term-btn dim" onClick={() => setDraft({})}>REVERT</button>}
        {msg && <span className={save.isError ? "down" : "dim"}>{msg}</span>}
      </div>
      <div className="dim text-[10px] mt-2">Hard limits are enforced by the server: risk per trade can never exceed 2% of equity, and every value is range-checked.</div>
    </div>
  );
}

function Reports() {
  const [open, setOpen] = useState<number | null>(null);
  const list = useQuery({ queryKey: ["reports"], queryFn: () => apiGet<ReportListItem[]>("/api/reports?limit=20"), refetchInterval: 60_000 });
  const full = useQuery({ queryKey: ["report", open], queryFn: () => apiGet<ReportFull>(`/api/reports/${open}`), enabled: open !== null });
  return (
    <div className="text-[11px]">
      {list.data?.length === 0 && <div className="p-3 dim">Daily reports are created after the close (16:20 ET) on days the market was open; weekly reports follow the week.</div>}
      {(list.data ?? []).map((r) => (
        <div key={r.id} className="border-b border-[#161616]">
          <button className="w-full text-left px-2 py-1 hover:bg-[#1a1a1a] flex justify-between" onClick={() => setOpen(open === r.id ? null : r.id)}>
            <span>{r.title}</span>
            <span className="dim">{r.kind}</span>
          </button>
          {open === r.id && <pre className="px-2 pb-2 whitespace-pre-wrap dim text-[10px]">{full.data?.body ?? "Loading…"}</pre>}
        </div>
      ))}
    </div>
  );
}

export default function MonitorWidget() {
  const [tab, setTab] = useState<Tab>("status");
  const { data: s, error } = useQuery({ queryKey: ["monitor-status"], queryFn: () => apiGet<MonitorStatus>("/api/monitor/status"), refetchInterval: 10_000 });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!s) return <div className="p-2 dim">Loading monitor…</div>;

  const w = s.worker;
  const regime = s.marketConditions ? REGIME_LABEL[s.marketConditions.regime] : REGIME_LABEL.unknown;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 p-1 border-b border-[var(--border)]">
        {(["status", "risk", "reports"] as Tab[]).map((t) => (
          <button key={t} className={`term-btn ${tab === t ? "amber" : "dim"}`} onClick={() => setTab(t)}>{t.toUpperCase()}</button>
        ))}
        <span className="amber text-[9px] ml-auto">PAPER ONLY</span>
      </div>
      <div className="overflow-auto flex-1">
        {tab === "status" && (
          <div className="p-2 text-[11px]">
            <div className={`font-bold mb-1 ${w.running ? "up" : "down"}`}>
              {w.running ? `● WORKER RUNNING · last cycle ${w.heartbeatAgeSec}s ago` : w.heartbeatAgeSec === null ? "○ WORKER NOT STARTED" : `○ WORKER STALLED · last cycle ${ago(Date.now() - (w.heartbeatAgeSec ?? 0) * 1000)} ago`}
            </div>
            {!w.running && <div className="dim mb-2">Start it with <code>npm run dev:worker</code> (or the docker compose worker service). Without it nothing is monitored and no alerts are produced.</div>}
            <Row k="Session" v={w.phase === "open" ? "market open" : "market not open"} cls={w.phase === "open" ? "up" : "dim"} />
            <Row k="Symbols monitored" v={`${w.monitoredSymbols} (${w.eligibleSymbols} with alert-grade data now)`} />
            <Row k="Cycle" v={`${w.pollSeconds ?? "—"}s poll · last took ${w.lastTickMs ?? "—"}ms · ${w.tickCount} cycles`} />
            <Row k="Errors" v={`${w.errorCount}${w.lastError ? ` · ${w.lastError}` : ""}`} cls={w.errorCount ? "down" : "dim"} />
            <Row k="Quote failures in a row" v={String(w.quoteFailures)} cls={w.quoteFailures ? "down" : "dim"} />
            <Row k="Telegram" v={s.notifications.telegram ? "configured" : "not configured"} cls={s.notifications.telegram ? "up" : "dim"} />
            <Row k="AI analysis" v={s.ai.enabled ? `${s.ai.used}/${s.ai.limit} calls today` : "off"} cls={s.ai.enabled ? "amber" : "dim"} />
            <Row k="Pending signals" v={String(s.counts.pendingSignals)} />

            <div className="mt-3 mb-1 dim uppercase text-[9px] tracking-wider">Market conditions</div>
            {s.marketConditions ? (
              <>
                <div className={`font-bold ${regime.cls}`}>{regime.label} <span className="dim font-normal">· {s.marketConditions.note}</span></div>
                <table className="data-table mt-1">
                  <thead><tr><th>Index</th><th>Last</th><th>Chg%</th><th>Data</th></tr></thead>
                  <tbody>
                    {s.marketConditions.indices.map((i) => (
                      <tr key={i.symbol}>
                        <td className="font-bold">{i.symbol}</td>
                        <td>{fmt(i.price)}</td>
                        <td className={i.changePercent === null ? "dim" : i.changePercent >= 0 ? "up" : "down"}>{fmt(i.changePercent)}%</td>
                        <td className="dim">{i.delayClass}{i.ageSec !== null ? ` · ${i.ageSec}s` : ""}{i.eligible ? "" : " · not alert-grade"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <div className="dim">No data yet.</div>
            )}
            <div className="dim text-[9px] mt-3">{s.disclaimer}</div>
          </div>
        )}
        {tab === "risk" && <RiskEditor status={s} />}
        {tab === "reports" && <Reports />}
      </div>
    </div>
  );
}
