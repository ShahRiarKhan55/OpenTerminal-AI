"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { apiGet, apiSend } from "../lib/api";
import type { WatchlistDto } from "../lib/engine";
import { normalizeMonitorSymbol } from "../lib/symbol";
import { useTerminal } from "../store/terminal";

const IMPORTED_KEY = "openterminal-watchlist-imported-v1";

/**
 * Keeps the dashboard watchlist in step with the server-side (SQLite) watchlist the monitoring
 * worker actually watches. The server is the source of truth. The first time this runs against a
 * server, a custom browser-local list is imported once (US stocks/ETFs only), so nothing is lost.
 * If the server is unreachable the local list simply keeps working.
 */
export default function WatchlistSync() {
  const qc = useQueryClient();
  const setWatchlist = useTerminal((s) => s.setWatchlist);
  const setWatchlistId = useTerminal((s) => s.setWatchlistId);

  const { data } = useQuery({
    queryKey: ["watchlists"],
    queryFn: () => apiGet<WatchlistDto[]>("/api/watchlists"),
    refetchInterval: 30_000,
    retry: 1,
  });

  useEffect(() => {
    if (!data || data.length === 0) return;
    const list = data.find((w) => w.name === "Default") ?? data[0];
    setWatchlistId(list.id);

    let imported = false;
    try {
      imported = localStorage.getItem(IMPORTED_KEY) === "1";
    } catch {
      /* private mode: treat as imported so we never overwrite the server */
      imported = true;
    }
    if (!imported) {
      const local = useTerminal.getState().watchlist.map(normalizeMonitorSymbol).filter((s): s is string => s !== null);
      const same = local.length === list.symbols.length && local.every((s) => list.symbols.includes(s));
      if (local.length > 0 && !same) {
        apiSend("PUT", `/api/watchlists/${list.id}/symbols`, { symbols: [...new Set(local)].slice(0, 100) })
          .then(() => {
            try {
              localStorage.setItem(IMPORTED_KEY, "1");
            } catch {
              /* ignore */
            }
            return qc.invalidateQueries({ queryKey: ["watchlists"] });
          })
          .catch(() => {
            /* keep the local list; retry on the next poll */
          });
        return;
      }
      try {
        localStorage.setItem(IMPORTED_KEY, "1");
      } catch {
        /* ignore */
      }
    }
    setWatchlist(list.symbols);
  }, [data, qc, setWatchlist, setWatchlistId]);

  return null;
}
