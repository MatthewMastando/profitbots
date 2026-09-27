import type { CoinStats } from "../market/types.js";
import { positionList, type AgentContext, type AgentState, type Position, type Side } from "./types.js";

export const r2 = (x: number | null | undefined, d = 2): number | null => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

export function positionNotional(p: Position, markPx: number, ctVal: number): number {
  return p.contracts * ctVal * markPx;
}

export function uplUsd(p: Position, markPx: number, ctVal: number): number {
  const dir = p.side === "long" ? 1 : -1;
  return dir * (markPx - p.entryPx) * p.contracts * ctVal;
}

export function minutesSince(ts: number | null, now: number): number {
  return ts === null ? 0 : Math.max(0, (now - ts) / 60_000);
}

/** Share of full leverage the book may use: at exactly MAX_LEVERAGE x equity the venue rejects for margin + fee. */
export const MARGIN_HEADROOM = 0.97;

/** Total notional the whole book may carry: min(MAX_LEVERAGE x equity x headroom, MAX_TOTAL_NOTIONAL_USD). */
export function maxTotalNotionalUsd(ctx: AgentContext): number {
  return Math.max(0, Math.min(ctx.cfg.risk.maxLeverage * ctx.agent.equityUsd * MARGIN_HEADROOM, ctx.cfg.risk.maxTotalNotionalUsd));
}

/** The most one position may be worth. */
export function maxPositionNotionalUsd(ctx: AgentContext): number {
  return maxTotalNotionalUsd(ctx) * ctx.cfg.risk.maxPositionFrac;
}

/** Mark-to-market notional of every open position. */
export function grossNotionalUsd(ctx: AgentContext): number {
  let n = 0;
  for (const p of positionList(ctx.agent)) {
    const s = ctx.view.stats.get(p.instId) ?? null;
    const inst = ctx.view.instruments.get(p.instId);
    const px = s?.mid ?? ctx.view.tickers.get(p.instId)?.mid ?? p.entryPx;
    if (inst) n += positionNotional(p, px, inst.ctVal);
  }
  return n;
}

/** Unrealised P&L of one position in R (null without a sized stop). */
export function uplR(p: Position, ctx: AgentContext): number | null {
  const s = ctx.view.stats.get(p.instId);
  const inst = ctx.view.instruments.get(p.instId);
  if (!s || !inst || !(p.riskUsd > 0)) return null;
  return uplUsd(p, s.mid, inst.ctVal) / p.riskUsd;
}

/**
 * Kelly-lite multiplier on base size from the realised record: win rate p, payoff ratio b = avg win / avg loss,
 * f = p - (1-p)/b. Half-Kelly, mapped to [0.5, 1.5] of base size, and 1 until 20 round trips are on the books.
 */
export function edgeMultiplier(a: AgentState): number {
  const { wins, losses, grossWinUsd, grossLossUsd } = a.record;
  const n = wins + losses;
  if (n < 20 || wins === 0) return n >= 20 && wins === 0 ? 0.5 : 1;
  if (losses === 0) return 1.5;
  const p = wins / n;
  const b = grossWinUsd / wins / (grossLossUsd / losses);
  if (!(b > 0)) return 0.5;
  const kelly = p - (1 - p) / b;
  return Math.max(0.5, Math.min(1.5, 1 + kelly));
}

/** ATR-multiple stop from the 15m ATR%. */
export function atrStop(s: CoinStats | undefined, side: Side, entryPx: number, mult: number): number | null {
  if (!s || s.atr14Pct === null) return null;
  const dist = entryPx * (s.atr14Pct / 100) * mult;
  return side === "long" ? entryPx - dist : entryPx + dist;
}

/**
 * Profit-lock stop candidate, or null below the first rung. `peakPx` is the best price since entry in the position's
 * favour; the stop keeps `keep` of the move from `entryPx` to it.
 */
export function profitLockStop(side: Side, entryPx: number, peakPx: number, rungs: ReadonlyArray<{ atPct: number; keep: number }>): number | null {
  const dir = side === "long" ? 1 : -1;
  const move = dir * (peakPx - entryPx);
  if (!(move > 0) || !(entryPx > 0)) return null;
  const gainPct = (move / entryPx) * 100;
  let keep = 0;
  for (const r of rungs) if (gainPct >= r.atPct) keep = Math.max(keep, r.keep);
  return keep > 0 ? entryPx + dir * keep * move : null;
}
