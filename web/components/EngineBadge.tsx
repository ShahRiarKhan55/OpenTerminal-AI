"use client";

import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import type { AlertsResponse, MonitorStatus } from "../lib/engine";
import { useTerminal } from "../store/terminal";

/** Always-visible health of the monitoring engine: mode, worker heartbeat and unread alerts. */
export default function EngineBadge() {
  const addWidget = useTerminal((s) => s.addWidget);
  const { data: status, isError } = useQuery({
    queryKey: ["monitor-status"],
    queryFn: () => apiGet<MonitorStatus>("/api/monitor/status"),
    refetchInterval: 10_000,
    retry: false,
  });
  const { data: alerts } = useQuery({
    queryKey: ["alerts-badge"],
    queryFn: () => apiGet<AlertsResponse>("/api/alerts?limit=1"),
    refetchInterval: 10_000,
    retry: false,
  });

  const running = status?.worker.running;
  const unread = alerts?.unacknowledgedImportant ?? 0;
  return (
    <span className="flex items-center gap-3">
      <span className="amber" title="Real-money brokerage execution is not implemented. All trades are simulated.">PAPER</span>
      <button
        className={running ? "up" : isError ? "dim" : "down"}
        onClick={() => addWidget("monitor")}
        title={
          running
            ? `Monitor running; last tick ${status?.worker.heartbeatAgeSec}s ago`
            : isError
            ? "Monitoring API unavailable"
            : "Monitoring worker is not running (npm run dev:worker)"
        }
      >
        MON {running ? "●" : "○"}
      </button>
      {unread > 0 && (
        <button className="down font-bold" onClick={() => addWidget("alerts")} title="Unacknowledged alerts">
          ▲ {unread}
        </button>
      )}
    </span>
  );
}
