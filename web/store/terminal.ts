"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiSend } from "../lib/api";
import { normalizeMonitorSymbol, normalizeSymbol } from "../lib/symbol";

export type WidgetType =
  | "quote"
  | "chart"
  | "watchlist"
  | "news"
  | "heatmap"
  | "screener"
  | "crypto"
  | "macro"
  | "options"
  | "portfolio"
  | "ai"
  | "calendar"
  | "insider"
  | "tv"
  | "recap"
  | "alerts"
  | "paper"
  | "monitor";

export type WidgetInstance = {
  id: string;
  type: WidgetType;
  symbol?: string;
  linked: boolean; // follows the globally active symbol
};

export type LayoutItem = { i: string; x: number; y: number; w: number; h: number };

type TerminalState = {
  activeSymbol: string;
  widgets: WidgetInstance[];
  layout: LayoutItem[];
  watchlist: string[];
  /** Id of the server-side list the worker monitors; null until the first sync. */
  watchlistId: number | null;
  watchlistError: string | null;
  commandOpen: boolean;
  setActiveSymbol: (s: string) => void;
  setCommandOpen: (open: boolean) => void;
  addWidget: (type: WidgetType, symbol?: string) => void;
  removeWidget: (id: string) => void;
  setWidgetSymbol: (id: string, symbol: string) => void;
  toggleLinked: (id: string) => void;
  setLayout: (layout: LayoutItem[]) => void;
  addToWatchlist: (s: string) => void;
  removeFromWatchlist: (s: string) => void;
  setWatchlist: (list: string[]) => void;
  setWatchlistId: (id: number | null) => void;
  clearWatchlistError: () => void;
  resetWorkspace: () => void;
  applyDayTraderLayout: () => void;
};

const DEFAULT_WIDGETS: WidgetInstance[] = [
  { id: "w-chart", type: "chart", linked: true },
  { id: "w-quote", type: "quote", linked: true },
  { id: "w-watchlist", type: "watchlist", linked: false },
  { id: "w-news", type: "news", linked: true },
  { id: "w-macro", type: "macro", linked: false },
];

const DEFAULT_LAYOUT: LayoutItem[] = [
  { i: "w-chart", x: 0, y: 0, w: 7, h: 12 },
  { i: "w-quote", x: 7, y: 0, w: 5, h: 6 },
  { i: "w-watchlist", x: 7, y: 6, w: 5, h: 6 },
  { i: "w-news", x: 0, y: 12, w: 7, h: 7 },
  { i: "w-macro", x: 7, y: 12, w: 5, h: 7 },
];

const SIZE_BY_TYPE: Record<WidgetType, { w: number; h: number }> = {
  quote: { w: 5, h: 6 },
  chart: { w: 7, h: 12 },
  watchlist: { w: 4, h: 7 },
  news: { w: 5, h: 8 },
  heatmap: { w: 7, h: 10 },
  screener: { w: 12, h: 9 },
  crypto: { w: 6, h: 9 },
  macro: { w: 5, h: 7 },
  options: { w: 12, h: 9 },
  portfolio: { w: 7, h: 8 },
  ai: { w: 5, h: 10 },
  calendar: { w: 12, h: 11 },
  insider: { w: 7, h: 9 },
  tv: { w: 6, h: 11 },
  recap: { w: 5, h: 12 },
  alerts: { w: 6, h: 11 },
  paper: { w: 7, h: 11 },
  monitor: { w: 5, h: 12 },
};

const DAY_TRADER_WIDGETS: WidgetInstance[] = [
  { id: "dt-chart", type: "chart", linked: true },
  { id: "dt-watchlist", type: "watchlist", linked: false },
  { id: "dt-alerts", type: "alerts", linked: false },
  { id: "dt-paper", type: "paper", linked: false },
  { id: "dt-monitor", type: "monitor", linked: false },
  { id: "dt-quote", type: "quote", linked: true },
];

const DAY_TRADER_LAYOUT: LayoutItem[] = [
  { i: "dt-chart", x: 0, y: 0, w: 6, h: 11 },
  { i: "dt-watchlist", x: 6, y: 0, w: 3, h: 7 },
  { i: "dt-quote", x: 9, y: 0, w: 3, h: 7 },
  { i: "dt-alerts", x: 6, y: 7, w: 6, h: 10 },
  { i: "dt-paper", x: 0, y: 11, w: 6, h: 10 },
  { i: "dt-monitor", x: 6, y: 17, w: 6, h: 10 },
];

export const useTerminal = create<TerminalState>()(
  persist(
    (set) => ({
      activeSymbol: "AAPL",
      widgets: DEFAULT_WIDGETS,
      layout: DEFAULT_LAYOUT,
      watchlist: ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "SPY"],
      watchlistId: null,
      watchlistError: null,
      commandOpen: false,
      setActiveSymbol: (s) => {
        const sym = normalizeSymbol(s);
        if (sym) set({ activeSymbol: sym });
      },
      setCommandOpen: (open) => set({ commandOpen: open }),
      addWidget: (type, symbol) =>
        set((st) => {
          const id = `w-${type}-${Date.now()}`;
          const size = SIZE_BY_TYPE[type];
          const maxY = st.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
          return {
            widgets: [...st.widgets, { id, type, symbol, linked: !symbol }],
            layout: [...st.layout, { i: id, x: 0, y: maxY, ...size }],
          };
        }),
      removeWidget: (id) =>
        set((st) => ({
          widgets: st.widgets.filter((w) => w.id !== id),
          layout: st.layout.filter((l) => l.i !== id),
        })),
      setWidgetSymbol: (id, symbol) => {
        const sym = normalizeSymbol(symbol);
        if (!sym) return;
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, symbol: sym, linked: false } : w)),
        }));
      },
      toggleLinked: (id) =>
        set((st) => ({
          widgets: st.widgets.map((w) => (w.id === id ? { ...w, linked: !w.linked } : w)),
        })),
      setLayout: (layout) => set({ layout }),
      addToWatchlist: (s) => {
        // The watchlist is what the monitoring worker watches, so it only accepts US stocks/ETFs.
        const sym = normalizeMonitorSymbol(s);
        if (!sym) {
          set({ watchlistError: `"${s.trim().toUpperCase()}" is not a US stock/ETF ticker. The watchlist is monitored for alerts and paper trading, which cover US stocks and ETFs only.` });
          return;
        }
        const { watchlistId, watchlist } = useTerminal.getState();
        if (watchlist.includes(sym)) return;
        set({ watchlist: [...watchlist, sym], watchlistError: null }); // optimistic
        if (watchlistId !== null) {
          apiSend("POST", `/api/watchlists/${watchlistId}/symbols`, { symbol: sym }).catch((e: Error) =>
            set((st) => ({ watchlist: st.watchlist.filter((x) => x !== sym), watchlistError: `Could not add ${sym}: ${e.message}` }))
          );
        }
      },
      removeFromWatchlist: (s) => {
        const { watchlistId } = useTerminal.getState();
        set((st) => ({ watchlist: st.watchlist.filter((x) => x !== s) }));
        if (watchlistId !== null) {
          apiSend("DELETE", `/api/watchlists/${watchlistId}/symbols/${encodeURIComponent(s)}`).catch((e: Error) =>
            set((st) => ({ watchlist: st.watchlist.includes(s) ? st.watchlist : [...st.watchlist, s], watchlistError: `Could not remove ${s}: ${e.message}` }))
          );
        }
      },
      setWatchlist: (list) => set({ watchlist: list, watchlistError: null }),
      setWatchlistId: (id) => set({ watchlistId: id }),
      clearWatchlistError: () => set({ watchlistError: null }),
      resetWorkspace: () => set({ widgets: DEFAULT_WIDGETS, layout: DEFAULT_LAYOUT }),
      applyDayTraderLayout: () => set({ widgets: DAY_TRADER_WIDGETS, layout: DAY_TRADER_LAYOUT }),
    }),
    {
      name: "openterminal-workspace",
      // Transient UI state is never persisted.
      partialize: (st) => {
        const { watchlistError, commandOpen, ...rest } = st;
        void watchlistError;
        void commandOpen;
        return rest;
      },
    }
  )
);

/** Symbol a widget should display: its own, or the active one when linked. */
export function useWidgetSymbol(widget: WidgetInstance): string {
  const active = useTerminal((s) => s.activeSymbol);
  return widget.linked ? active : widget.symbol ?? active;
}
