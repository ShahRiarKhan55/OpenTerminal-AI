"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { apiGet } from "../lib/api";
import { useTerminal } from "../store/terminal";
import EngineBadge from "./EngineBadge";

type Status = {
  ok: boolean;
  providers: Array<{ name: string; ok: number; failed: number; lastLatencyMs: number | null }>;
  ai: boolean;
};

function Clock({ tz, label }: { tz: string; label: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) return null;
  return (
    <span className="dim">
      {label}{" "}
      <span className="text-[var(--text)]">
        {now.toLocaleTimeString("en-GB", { timeZone: tz, hour12: false })}
      </span>
    </span>
  );
}

function marketStateNY(): { label: string; open: boolean } {
  const ny = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = ny.getDay();
  const mins = ny.getHours() * 60 + ny.getMinutes();
  const open = day >= 1 && day <= 5 && mins >= 570 && mins < 960; // 09:30–16:00
  return { label: open ? "NYSE OPEN" : "NYSE CLOSED", open };
}

export default function TopBar({ showSearch = true }: { showSearch?: boolean } = {}) {
  const pathname = usePathname();
  const setCommandOpen = useTerminal((s) => s.setCommandOpen);
  const activeSymbol = useTerminal((s) => s.activeSymbol);
  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<Status>("/api/status"),
    refetchInterval: 30_000,
  });

  const market = marketStateNY();
  const healthy = status?.providers.filter((p) => p.ok > 0) ?? [];

  return (
    <header className="flex items-center gap-4 px-3 h-8 bg-[var(--panel-2)] border-b border-[var(--border)] text-[11px] shrink-0 overflow-x-auto whitespace-nowrap">
      <span className="amber font-bold tracking-widest">OPENTERMINAL</span>
      <nav className="flex items-center gap-3" aria-label="Pages">
        {[
          { href: "/", label: "TERMINAL" },
          { href: "/portfolio", label: "MY PORTFOLIO" },
        ].map((l) => (
          <Link key={l.href} href={l.href} className={pathname === l.href ? "amber font-bold" : "dim hover:text-[var(--amber)]"} aria-current={pathname === l.href ? "page" : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      <span className={market.open ? "up" : "down"}>● {market.label}</span>
      <span className="hidden md:flex items-center gap-4">
        <Clock tz="America/New_York" label="NY" />
        <Clock tz="Europe/Rome" label="MIL" />
        <Clock tz="Europe/London" label="LDN" />
      </span>
      <span className="hidden sm:inline"><Clock tz="Asia/Tokyo" label="TYO" /></span>
      {showSearch && (
        <button className="term-btn flex-1 max-w-md text-left dim" onClick={() => setCommandOpen(true)}>
          {activeSymbol} — search symbol… <span className="float-right">⌘K</span>
        </button>
      )}
      <span className="dim ml-auto">
        feeds:{" "}
        {healthy.length > 0
          ? healthy.map((p) => `${p.name} ${p.lastLatencyMs ?? "—"}ms`).join(" · ")
          : "connecting…"}
      </span>
      <span className={status?.ai ? "up" : "dim"}>AI {status?.ai ? "●" : "○"}</span>
      <EngineBadge />
    </header>
  );
}
