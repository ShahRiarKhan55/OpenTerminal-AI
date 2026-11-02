import { audit } from "../audit.js";
import { IMPORTANCE_RANK } from "../config.js";
import { applySlippage, evaluateEntry, evaluateExit } from "../engine/entryExit.js";
import { closePosition, getAccount, listOpenPositions, loadRiskState, markPosition, openPosition, raiseStop, InsufficientCashError, type PositionRow } from "../engine/paper.js";
import { checkRisk, type RiskConfig } from "../engine/risk.js";
import { insertSignal, pendingSignals, setSignalStatus, type SignalRow } from "../engine/store.js";
import type { SignalCandidate } from "../engine/types.js";
import type { FreshnessResult } from "../marketdata/freshness.js";
import { etClock } from "../marketdata/time.js";
import type { Observation } from "../marketdata/types.js";
import { enrichWithAi, raiseAlert } from "../notify/alerts.js";
import type { Quote } from "../providers/yahoo.js";
import type { Runtime, WorkerDeps } from "./runtime.js";

export type Obs = { quote: Quote; obs: Observation; strict: FreshnessResult; relaxed: FreshnessResult };

export type TickCtx = {
  deps: WorkerDeps;
  rt: Runtime;
  now: number;
  risk: RiskConfig;
  /** AI calls already made this tick; capped so a burst of events can't stall the loop on slow API calls. */
  aiBudgetThisTick: { left: number };
  regime: string;
};

const DAY_MS = 86_400_000;
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

/**
 * At most a few AI calls per tick, so a burst of events can't stall the loop on slow API calls.
 * An alert that misses its slot is marked skipped (never left ambiguous) but is still delivered.
 */
export function takeAiSlot(ctx: TickCtx, alertId: number, importance: "low" | "normal" | "high"): boolean {
  const ai = ctx.deps.cfg.ai;
  if (!ctx.deps.ai || !ai.enabled || IMPORTANCE_RANK[importance] < IMPORTANCE_RANK[ai.minImportance]) return false; // not eligible: nothing to record
  if (ctx.aiBudgetThisTick.left > 0) {
    ctx.aiBudgetThisTick.left--;
    return true;
  }
  ctx.deps.db.prepare("UPDATE alerts SET ai_status = 'skipped_budget' WHERE id = ? AND ai_status = 'none'").run(alertId);
  return false;
}

export function dataLabel(o: Obs, now: number): string {
  const age = o.relaxed.ageSec ?? o.strict.ageSec;
  const parts: string[] = [o.obs.delayClass === "realtime" ? "provider-reported real-time" : "delayed/indicative"];
  if (age !== null) parts.push(`${Math.max(0, Math.round(age))}s old`);
  parts.push(o.obs.source);
  void now;
  return parts.join(" · ");
}

function verdictInput(sig: Pick<SignalRow, "symbol" | "stop" | "target">, fillPrice: number, q: Quote) {
  return { symbol: sig.symbol, stop: sig.stop, target: sig.target, fillPrice, bid: q.bid, ask: q.ask, avgVolume: q.avgVolume };
}

/** A brand-new candidate from a detector: persist (deduped), screen, announce, and try to enter. */
export async function handleCandidate(ctx: TickCtx, c: SignalCandidate, o: Obs): Promise<void> {
  const { deps, now, risk } = ctx;
  const { db, cfg, ai } = deps;
  const price = o.quote.price!;
  const row = insertSignal(db, c, now);
  if (!row) return; // already produced this session: de-duplicated

  audit(db, { kind: "signal", symbol: c.symbol, decision: "detected", reason: c.strategy, detail: { signalId: row.id, entry: c.entry, stop: c.stop, target: c.target, meta: c.meta } }, now);

  const fill = applySlippage(Math.max(price, c.entry), "BUY", risk.slippageBps);
  const verdict = checkRisk(verdictInput(row, fill, o.quote), loadRiskState(db, now), risk, now);
  if (!verdict.pass) {
    blockSignal(ctx, row, verdict.reasons, verdict);
    return;
  }

  const rr = row.reward_risk.toFixed(1);
  const label = dataLabel(o, now);
  const alert = raiseAlert(
    { db, nowMs: now, cfg },
    {
      type: "signal",
      symbol: c.symbol,
      importance: "normal",
      dedupeKey: `signal:${c.strategy}:${c.symbol}:${c.sessionDate}`,
      cooldownMs: DAY_MS,
      title: `${c.symbol} ${c.strategy.toUpperCase()} long setup`,
      body: `${c.symbol} ${c.strategy === "orb" ? "opening-range breakout" : "20-day high breakout"}. Plan: entry ${c.entry.toFixed(2)}, stop ${c.stop.toFixed(2)}, target ${c.target.toFixed(2)} (reward/risk ${rr}). Sized at ${verdict.qty} sh, risking ${money(verdict.riskAmount)}. Last ${price.toFixed(2)}.`,
      dataLabel: label,
      payload: { signalId: row.id, ...c.meta },
    }
  );
  if ("alertId" in alert && !takeAiSlot(ctx, alert.alertId, "normal")) {
    // throttled this tick: already recorded as skipped
  } else if ("alertId" in alert) {
    await enrichWithAi(
      { db, nowMs: now, cfg, provider: ai, log: deps.log },
      alert.alertId,
      { kind: `${c.strategy}_signal`, symbol: c.symbol, facts: { entry: c.entry, stop: c.stop, target: c.target, rewardRisk: c.rewardRisk, last: price, changePercent: o.quote.changePercent, regime: ctx.regime, dataLabel: label, setup: c.meta } },
      "normal"
    );
  }
  await tryEntry(ctx, row, o);
}

function blockSignal(ctx: TickCtx, row: SignalRow, reasons: string[], verdict: unknown): void {
  const { db, cfg } = ctx.deps;
  setSignalStatus(db, row.id, "blocked", ctx.now, { reason: reasons.join(","), verdict });
  audit(db, { kind: "risk", symbol: row.symbol, decision: "blocked", reason: reasons.join(","), detail: { signalId: row.id, verdict } }, ctx.now);
  raiseAlert(
    { db, nowMs: ctx.now, cfg },
    {
      type: "signal_blocked",
      symbol: row.symbol,
      importance: "low",
      dedupeKey: `blocked:${row.id}`,
      cooldownMs: DAY_MS,
      title: `${row.symbol} ${row.strategy.toUpperCase()} setup blocked by risk rules`,
      body: `Not taken: ${reasons.join(", ").replace(/_/g, " ")}.`,
    }
  );
}

/** Where is this signal now? Fill it (after a fresh risk check), keep waiting, or retire it. */
export async function tryEntry(ctx: TickCtx, row: SignalRow, o: Obs): Promise<void> {
  const { deps, now, risk } = ctx;
  const { db, cfg } = deps;
  const price = o.quote.price!;
  const d = evaluateEntry({ entry: row.entry, stop: row.stop, riskPerShare: row.risk_per_share, validUntilMs: row.valid_until }, price, now, risk);
  switch (d.action) {
    case "wait": {
      // Remember WHY we're waiting, so an expiry can be reported accurately (extended vs never triggered).
      const why = d.extended ? "extended" : "waiting";
      if (row.reason !== why) db.prepare("UPDATE signals SET reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(why, now, row.id);
      return;
    }
    case "expire":
    case "invalidate": {
      const status = d.action === "invalidate" ? "invalidated" : row.reason === "extended" ? "skipped_chase" : "expired";
      setSignalStatus(db, row.id, status, now, { reason: d.action });
      audit(db, { kind: "signal", symbol: row.symbol, decision: status, detail: { signalId: row.id, price } }, now);
      return;
    }
    case "fill": {
      const fill = applySlippage(d.refPrice, "BUY", risk.slippageBps);
      const verdict = checkRisk(verdictInput(row, fill, o.quote), loadRiskState(db, now), risk, now);
      if (!verdict.pass) return blockSignal(ctx, row, verdict.reasons, verdict);
      try {
        const { id, created } = openPosition(db, {
          signalId: row.id, symbol: row.symbol, strategy: row.strategy, qty: verdict.qty, fillPrice: fill, stop: row.stop, target: row.target,
          riskPerShare: fill - row.stop, nowMs: now, sessionDate: row.session_date, commission: risk.commissionPerOrder,
        });
        setSignalStatus(db, row.id, "filled", now, { verdict });
        if (!created) return;
        audit(db, { kind: "order", symbol: row.symbol, decision: "paper_buy", detail: { positionId: id, qty: verdict.qty, fill, stop: row.stop, target: row.target } }, now);
        raiseAlert(
          { db, nowMs: now, cfg },
          {
            type: "position_opened",
            symbol: row.symbol,
            importance: "normal",
            dedupeKey: `opened:${id}`,
            cooldownMs: DAY_MS,
            title: `Paper BUY ${verdict.qty} ${row.symbol} @ ${fill.toFixed(2)}`,
            body: `${row.strategy.toUpperCase()} entry filled in the paper account. Stop ${row.stop.toFixed(2)}, target ${row.target.toFixed(2)}, risking ${money(verdict.riskAmount)}. Simulated fill includes ${risk.slippageBps} bps slippage.`,
            dataLabel: dataLabel(o, now),
          }
        );
      } catch (err) {
        if (err instanceof InsufficientCashError) return blockSignal(ctx, row, ["insufficient_cash"], { cash: getAccount(db).cash });
        throw err;
      }
    }
  }
}

export async function processPendingSignals(ctx: TickCtx, obs: Map<string, Obs>): Promise<void> {
  const { db } = ctx.deps;
  for (const row of pendingSignals(db)) {
    if (ctx.now > row.valid_until) {
      const status = row.reason === "extended" ? "skipped_chase" : "expired";
      setSignalStatus(db, row.id, status, ctx.now, { reason: "expire" });
      audit(db, { kind: "signal", symbol: row.symbol, decision: status, detail: { signalId: row.id } }, ctx.now);
      continue;
    }
    const o = obs.get(row.symbol);
    if (!o || !o.strict.ok) continue; // never act on stale/incomplete/out-of-session prices
    await tryEntry(ctx, row, o);
  }
}

function closeAndAnnounce(ctx: TickCtx, pos: PositionRow, fill: number, reason: string, o: Obs | null): void {
  const { deps, now, risk } = ctx;
  const { db, cfg } = deps;
  const closed = closePosition(db, pos.id, fill, reason, now, risk.commissionPerOrder);
  if (!closed) return;
  audit(db, { kind: "order", symbol: pos.symbol, decision: "paper_sell", reason, detail: { positionId: pos.id, fill, pnl: closed.realized_pnl, r: closed.r_multiple } }, now);
  const pnl = closed.realized_pnl ?? 0;
  const label = reason.replace(/_/g, " ");
  raiseAlert(
    { db, nowMs: now, cfg },
    {
      type: "position_closed",
      symbol: pos.symbol,
      importance: reason === "stop" ? "high" : "normal",
      dedupeKey: `closed:${pos.id}`,
      cooldownMs: DAY_MS,
      title: `Paper SELL ${pos.symbol} (${label}) ${money(pnl)}`,
      body: `${pos.qty} sh closed at ${fill.toFixed(2)} (entry ${pos.entry_price.toFixed(2)}). Result ${money(pnl)}, ${closed.r_multiple?.toFixed(2) ?? "n/a"}R. Reason: ${label}.`,
      dataLabel: o ? dataLabel(o, now) : "last known mark (no fresh price)",
    }
  );
}

export function manageOpenPositions(ctx: TickCtx, obs: Map<string, Obs>): void {
  const { deps, now, risk } = ctx;
  const { db, cfg, log } = deps;
  const clock = etClock(now);
  for (const pos of listOpenPositions(db)) {
    const o = obs.get(pos.symbol);
    if (o && o.relaxed.ok && o.quote.price !== null) {
      const price = o.quote.price;
      markPosition(db, pos.id, price, now);
      const d = evaluateExit(
        { entryPrice: pos.entry_price, stopPrice: pos.stop_price, targetPrice: pos.target_price, riskPerShare: pos.risk_per_share, sessionDate: pos.session_date },
        price, now, o.obs.phase, risk
      );
      if (d.action === "exit") closeAndAnnounce(ctx, pos, d.fill, d.reason, o);
      else if (d.newStop !== undefined && raiseStop(db, pos.id, d.newStop)) {
        audit(db, { kind: "order", symbol: pos.symbol, decision: "stop_to_breakeven", detail: { positionId: pos.id, newStop: d.newStop, price } }, now);
      }
      continue;
    }

    // No usable price for this position.
    const afterClose = clock.minutes >= 16 * 60 + 15;
    if (pos.session_date < clock.dateKey || (pos.session_date === clock.dateKey && afterClose)) {
      // Day-trading discipline beats waiting for data that may never come: flatten at the last known mark.
      const mark = pos.last_price ?? pos.entry_price;
      audit(db, { kind: "order", symbol: pos.symbol, decision: "closed_on_last_mark", reason: "no_fresh_price", detail: { positionId: pos.id, mark } }, now);
      closeAndAnnounce(ctx, pos, mark, "session_end", null);
      continue;
    }
    const lastAt = pos.last_price_at ?? pos.opened_at;
    if (clock.isWeekday && clock.minutes >= 9 * 60 + 30 && now - lastAt > 10 * 60_000) {
      log.warn("no fresh price for open position", { symbol: pos.symbol, staleMinutes: Math.round((now - lastAt) / 60_000) });
      raiseAlert(
        { db, nowMs: now, cfg },
        {
          type: "data_stale_position",
          symbol: pos.symbol,
          importance: "high",
          dedupeKey: `stale:${pos.id}`,
          cooldownMs: 30 * 60_000,
          title: `${pos.symbol}: no fresh price for an open paper position`,
          body: `No acceptable quote for ${Math.round((now - lastAt) / 60_000)} minutes. Stop (${pos.stop_price.toFixed(2)}) and target (${pos.target_price.toFixed(2)}) cannot be evaluated until data recovers. Paper position only.`,
        }
      );
    }
  }
}

/** After any close: has the daily loss limit been hit? */
export function checkDailyLossLimit(ctx: TickCtx): void {
  const { db, cfg } = ctx.deps;
  const s = loadRiskState(db, ctx.now);
  const pnl = s.realizedToday + s.unrealizedOpen;
  const start = s.equity - pnl;
  if (start > 0 && pnl <= -(start * ctx.risk.maxDailyLossPct) / 100) {
    raiseAlert(
      { db, nowMs: ctx.now, cfg },
      {
        type: "daily_loss_limit",
        symbol: null,
        importance: "high",
        dedupeKey: `dll:${etClock(ctx.now).dateKey}`,
        cooldownMs: DAY_MS,
        title: "Daily loss limit reached: new paper entries are blocked",
        body: `Today's paper P&L is ${money(pnl)} (limit ${ctx.risk.maxDailyLossPct}% of starting equity). No new entries until tomorrow.`,
      }
    );
  }
}
