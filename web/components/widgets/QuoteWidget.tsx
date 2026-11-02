"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet, fmt, fmtBig, pctClass, type Quote } from "../../lib/api";
import { useWidgetSymbol, type WidgetInstance } from "../../store/terminal";
import Flash from "../Flash";

type ShortVolume = { date: string; shortVolume: number; shortExemptVolume: number; totalVolume: number; shortVolumePercent: number };

/** Honest data-quality line: how timely the price is, and whether it would be accepted for alerts. */
function DataAge({ quote }: { quote: Quote }) {
  const f = quote.freshness;
  const delay = quote.delayClass === "realtime" ? "provider-reported real-time" : quote.delayClass === "eod" ? "end-of-day" : "delayed / indicative";
  const age = f?.ageSec != null ? ` · ${Math.max(0, Math.round(f.ageSec))}s old` : "";
  const stale = quote.servedStale ? " · LAST KNOWN (provider unavailable)" : "";
  return (
    <div className="text-[10px] mb-1" title="Prices come from free public endpoints and are never exchange-grade.">
      <span className={quote.servedStale ? "down" : "dim"}>{delay}{age}{stale}</span>
      {f && (
        <span className={f.ok ? "up" : "dim"}> · {f.ok ? "alert-grade" : `not alert-grade (${f.reason.replace(/_/g, " ")})`}</span>
      )}
    </div>
  );
}

export default function QuoteWidget({ widget }: { widget: WidgetInstance }) {
  const symbol = useWidgetSymbol(widget);
  const { data, error } = useQuery({
    queryKey: ["quote", symbol],
    queryFn: async () => (await apiGet<Quote[]>(`/api/quotes?symbols=${encodeURIComponent(symbol)}`))[0],
    refetchInterval: 1_000,
  });
  // FINRA's Reg SHO file only updates once a day (next-morning), so no point polling it fast.
  const { data: shortVol } = useQuery({
    queryKey: ["short-volume", symbol],
    queryFn: () => apiGet<ShortVolume | null>(`/api/short-volume/${encodeURIComponent(symbol)}`),
    staleTime: 3_600_000,
  });

  if (error) return <div className="p-2 down">Error: {(error as Error).message}</div>;
  if (!data) return <div className="p-2 dim">Loading {symbol}…</div>;

  const rows: Array<[string, string, string?]> = [
    ["Open", fmt(data.open)],
    ["High", fmt(data.high)],
    ["Low", fmt(data.low)],
    ["Prev Close", fmt(data.previousClose)],
    ["Bid", fmt(data.bid)],
    ["Ask", fmt(data.ask)],
    ["Volume", fmtBig(data.volume)],
    ["Avg Vol 3M", fmtBig(data.avgVolume)],
    ...(shortVol ? ([["Short Vol %", fmt(shortVol.shortVolumePercent, 1) + "%"]] as Array<[string, string]>) : []),
    ["Mkt Cap", fmtBig(data.marketCap)],
    ["P/E (ttm)", fmt(data.pe)],
    ["EPS (ttm)", fmt(data.eps)],
    ["Div Yield", data.dividendYield !== null ? fmt(data.dividendYield * 100) + "%" : "—"],
    ["52W High", fmt(data.week52High)],
    ["52W Low", fmt(data.week52Low)],
    ["Beta", fmt(data.beta)],
    ["Shares Out", fmtBig(data.sharesOutstanding)],
  ];

  return (
    <div className="p-2">
      <div className="flex items-baseline gap-3 mb-1">
        <Flash value={data.price} className="text-xl font-bold">{fmt(data.price)}</Flash>
        <Flash value={data.changePercent} className={`${pctClass(data.changePercent)} text-sm`}>
          {data.change !== null && data.change >= 0 ? "+" : ""}
          {fmt(data.change)} ({fmt(data.changePercent)}%)
        </Flash>
        <span className="dim text-[10px] ml-auto">
          {data.exchange ?? ""} · {data.currency ?? ""} · {data.source}
        </span>
      </div>
      <DataAge quote={data} />
      <div className="dim text-[11px] mb-2 truncate">{data.name}</div>
      <div className="grid grid-cols-2 gap-x-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-[#161616] py-0.5">
            <span className="dim">{label}</span>
            <span>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
