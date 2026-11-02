// Types and helpers for the monitoring engine API (server/src/routes/trading.ts).

export type Importance = "low" | "normal" | "high";

export type AlertItem = {
  id: number;
  created_at: number;
  symbol: string | null;
  type: string;
  importance: Importance;
  title: string;
  body: string;
  data_label: string | null;
  ai_status: "none" | "done" | "skipped_budget" | "skipped_disabled" | "failed";
  ai_analysis: string | null;
  acknowledged_at: number | null;
  telegram_status: string;
};
export type AlertsResponse = { alerts: AlertItem[]; unacknowledgedImportant: number };

export type SignalItem = {
  id: number;
  created_at: number;
  symbol: string;
  strategy: string;
  status: "pending" | "filled" | "blocked" | "expired" | "invalidated" | "skipped_chase";
  entry: number;
  stop: number;
  target: number;
  reward_risk: number;
  reason: string | null;
};

export type PositionItem = {
  id: number;
  symbol: string;
  strategy: string;
  qty: number;
  entry_price: number;
  stop_price: number;
  initial_stop: number;
  target_price: number;
  risk_per_share: number;
  opened_at: number;
  status: "open" | "closed";
  last_price: number | null;
  last_price_at: number | null;
  exit_price: number | null;
  closed_at: number | null;
  exit_reason: string | null;
  realized_pnl: number | null;
  r_multiple: number | null;
  notes: string | null;
};

export type PaperStats = { closedTrades: number; wins: number; losses: number; winRate: number | null; totalPnl: number; avgR: number | null };

export type AccountSummary = {
  mode: "paper";
  startingCash: number;
  cash: number;
  equity: number;
  openValue: number;
  unrealizedPnl: number;
  realizedToday: number;
  dailyPnl: number;
  allTimePnl: number;
  tradesToday: number;
  openPositions: number;
  openRisk: number;
  limits: { maxOpenPositions: number; maxTradesPerDay: number; maxDailyLossPct: number; tradingEnabled: boolean };
  today: PaperStats;
  allTime: PaperStats;
};

export type MarketConditions = {
  asOf: number;
  regime: "risk_on" | "risk_off" | "neutral" | "unknown";
  indices: { symbol: string; price: number | null; changePercent: number | null; ageSec: number | null; delayClass: string; eligible: boolean }[];
  vix: number | null;
  note: string;
};

export type RiskConfig = {
  tradingEnabled: boolean;
  riskPerTradePct: number;
  maxPositionPct: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  maxTradesPerDay: number;
  minRewardRisk: number;
  entryStart: string;
  entryEnd: string;
  flatBy: string;
  [k: string]: number | string | boolean;
};

export type MonitorStatus = {
  version: string;
  mode: "paper";
  worker: {
    running: boolean;
    heartbeatAgeSec: number | null;
    tickCount: number;
    errorCount: number;
    lastError: string | null;
    quoteFailures: number;
    monitoredSymbols: number;
    eligibleSymbols: number;
    phase: string;
    pollSeconds: number | null;
    lastTickMs: number | null;
  };
  notifications: { telegram: boolean };
  ai: { enabled: boolean; used: number; limit: number; remaining: number };
  marketConditions: MarketConditions | null;
  conditionsAgeSec: number | null;
  risk: { config: RiskConfig; usingDefaultsBecauseStoredInvalid: boolean };
  counts: { pendingSignals: number; unacknowledgedAlerts: number };
  disclaimer: string;
};

export type ReportListItem = { id: number; kind: "daily" | "weekly"; period_key: string; created_at: number; title: string };
export type ReportFull = ReportListItem & { body: string };

export type WatchlistDto = { id: number; name: string; symbols: string[] };

export const money = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const signed = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(digits)}`;

export const pnlClass = (n: number | null | undefined): string => (n === null || n === undefined || n === 0 ? "dim" : n > 0 ? "up" : "down");

/** Wall-clock time in New York, since exchange hours are what traders reason in. */
export function etTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

export const IMPORTANCE_COLOR: Record<Importance, string> = {
  high: "var(--down)",
  normal: "var(--amber)",
  low: "#555",
};

export const REGIME_LABEL: Record<MarketConditions["regime"], { label: string; cls: string }> = {
  risk_on: { label: "RISK-ON", cls: "up" },
  risk_off: { label: "RISK-OFF", cls: "down" },
  neutral: { label: "NEUTRAL", cls: "amber" },
  unknown: { label: "UNKNOWN", cls: "dim" },
};

export const SIGNAL_STATUS_CLASS: Record<SignalItem["status"], string> = {
  pending: "amber",
  filled: "up",
  blocked: "down",
  expired: "dim",
  invalidated: "dim",
  skipped_chase: "dim",
};
