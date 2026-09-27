// The one agent's brain: breakout, trend and momentum lenses feed a single Jev menu. Jev picks the move that it
// believes makes the most money; deterministic code (risk.ts) sizes it, caps it and manages every stop.
import type { CoinStats, MarketView } from "../market/types.js";
import { atrStop, maxPositionNotionalUsd, minutesSince, positionNotional, r2, uplR } from "./common.js";
import { positionList, type AgentContext, type Brain, type Intent, type Lens, type Menu, type Position, type Side } from "./types.js";

/** Trend lens: open only from a clear ensemble reading. */
const TREND_MIN_SCORE = 3;
const VOL_TARGET_PCT = 60;
/** Momentum lens: enter at half the per-position cap, pyramid by a quarter per ATR run; commit 24 h before bailing. */
const MOMENTUM_ENTRY_FRAC = 0.5;
const ADD_FRAC = 0.25;
export const MOMENTUM_MIN_HOLD_MIN = 24 * 60;
const TRAIL_ATR1H = 3;
/** Long veto when 30-day funding z is stretched (crowded long). */
export const FUNDING_Z_BLOCK_LONG = 1.5;

export const PROFIT_LOCK = [
  { atPct: 2.5, keep: 0.5 },
  { atPct: 5, keep: 0.65 },
] as const;

const atr1hPx = (s: CoinStats | undefined) => (s && s.atr14Pct !== null ? (s.mid * s.atr14Pct * 2) / 100 : null);
const toTrigger = (s: CoinStats) => (s.breakout ? ((s.breakout.trigger - s.mid) / s.mid) * 100 : null);
const nextUtcMidnight = (ms: number) => (Math.floor(ms / 86_400_000) + 1) * 86_400_000;

function zs(xs: number[]): (x: number) => number {
  const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1;
  return (x) => (x - m) / sd;
}

export interface Candidate {
  s: CoinStats;
  score: number;
}

/** Momentum on 7-day return, plus a small attention bonus (news z, or volume z when news is unavailable). */
export function rankMomentum(view: MarketView, spreadGateBps: number): Candidate[] {
  const pool = view.gated.map((id) => view.stats.get(id)).filter((s): s is CoinStats => !!s && s.ret24hPct !== null && s.spreadBp <= spreadGateBps);
  if (!pool.length) return [];
  const z24 = zs(pool.map((s) => s.ret24hPct!));
  const z7 = zs(pool.map((s) => s.ret7dPct ?? s.ret24hPct!));
  return pool
    .map((s) => ({ s, score: z7(s.ret7dPct ?? s.ret24hPct!) + 0.1 * z24(s.ret24hPct!) + 0.3 * Math.max(0, s.newsZ ?? s.volZ ?? 0) }))
    .sort((a, b) => b.score - a.score);
}

function byCoin(ctx: AgentContext, coins: string[]): CoinStats[] {
  const m = new Map([...ctx.view.stats.values()].map((s) => [s.coin, s]));
  return coins.map((c) => m.get(c)).filter((s): s is CoinStats => !!s && s.spreadBp <= ctx.cfg.risk.spreadGateBps);
}

/** Trend size: max(1/3, |score|/9) of the per-position cap, capped so the position stays under 60% annualised vol. */
export function trendSizeFrac(s: CoinStats, ctx: AgentContext): number {
  if (!s.trend) return 0;
  const byScore = Math.max(1 / 3, Math.abs(s.trend.score) / 9);
  const max = maxPositionNotionalUsd(ctx);
  const rv = s.trend.rv90Pct;
  const volCap = rv && rv > 0 && max > 0 ? (ctx.agent.equityUsd * (VOL_TARGET_PCT / rv)) / max : 1;
  return Math.max(0, Math.min(byScore, volCap, 1));
}

const label = (verb: string, coin: string) => `${verb}_${coin.replace(/[^A-Z0-9]/gi, "")}`;

export const brain: Brain = {
  strategy:
    "You are one trading agent running a leveraged crypto futures book. Your only goal is to maximise total profit after fees. " +
    "Three lenses feed your menu: BREAKOUT (price through today's open plus half of yesterday's range, ride to the day close), " +
    "TREND (9-slice Donchian ensemble on 4h bars, score -9..+9, trade with a strong score), MOMENTUM (the week's hottest coins, long, hold at least 24h). " +
    "You may hold several positions at once; the code caps total exposure and manages every stop. " +
    "Open only when the setup is real and the expected move pays for fees; ADD only to winners; CLOSE what is failing; HOLD when nothing is clearly better. " +
    "Prefer fewer, better trades over churn.",
  convictionLabels: ["weak", "fair", "strong", "overwhelming"],
  profitLock: PROFIT_LOCK,

  snapshotCoins(ctx) {
    const ids = new Set<string>();
    for (const s of byCoin(ctx, ctx.cfg.strategy.trendCoins)) ids.add(s.instId);
    for (const s of byCoin(ctx, ctx.cfg.strategy.breakoutCoins)) if (s.breakout) ids.add(s.instId);
    for (const c of rankMomentum(ctx.view, ctx.cfg.risk.spreadGateBps).slice(0, ctx.cfg.strategy.momentumCandidates)) ids.add(c.s.instId);
    for (const p of positionList(ctx.agent)) ids.add(p.instId);
    return [...ids];
  },

  coinSnapshot(s, ctx) {
    const p = ctx.agent.positions[s.instId];
    const held = p ? `${p.side} ${p.lens}` : null;
    return {
      held,
      upl_r: p ? r2(uplR(p, ctx), 1) : null,
      held_min: p ? r2(minutesSince(p.openedAt, ctx.now), 0) : null,
      trend: s.trend ? s.trend.score : null,
      to_trigger_pct: r2(toTrigger(s)),
      r1h_pct: r2(s.ret1hPct, 1),
      r24h_pct: r2(s.ret24hPct, 1),
      r7d_pct: r2(s.ret7dPct, 0),
      rsi: r2(s.rsi14, 0),
      atr_pct: r2(s.atr14Pct),
      fund_z: r2(s.fundingZ, 1),
      attn_z: r2(s.newsZ ?? s.volZ, 1),
      oi1h_pct: r2(s.oiChg1hPct, 1),
      spread_bp: r2(s.spreadBp, 0),
    };
  },

  menu(ctx) {
    const m: Menu = {};
    const { agent, cfg } = ctx;
    const held = agent.positions;
    const capacity = cfg.risk.maxPositions === 0 || positionList(agent).length < cfg.risk.maxPositions;

    if (capacity) {
      // Breakout lens: long through today's trigger.
      for (const s of byCoin(ctx, cfg.strategy.breakoutCoins)) {
        const t = toTrigger(s);
        if (held[s.instId] || t === null || t > 0) continue;
        m[label("BREAKOUT", s.coin)] = { desc: `through trigger by ${(-t).toFixed(2)}%`, intent: { kind: "open", instId: s.instId, side: "long", lens: "breakout", sizeFrac: 1, setup: "strict" } };
      }
      // Trend lens: with the ensemble, both ways.
      for (const s of byCoin(ctx, cfg.strategy.trendCoins)) {
        if (held[s.instId] || !s.trend || Math.abs(s.trend.score) < TREND_MIN_SCORE) continue;
        const side: Side = s.trend.score > 0 ? "long" : "short";
        m[label(`TREND_${side.toUpperCase()}`, s.coin)] = { desc: `score ${s.trend.score}`, intent: { kind: "open", instId: s.instId, side, lens: "trend", sizeFrac: trendSizeFrac(s, ctx), setup: "strict" } };
      }
      // Momentum lens: the week's leaders.
      const top = rankMomentum(ctx.view, cfg.risk.spreadGateBps).slice(0, cfg.strategy.momentumCandidates);
      for (const [i, c] of top.entries()) {
        if (held[c.s.instId]) continue;
        const longBlocked = c.s.fundingZ !== null && c.s.fundingZ > FUNDING_Z_BLOCK_LONG;
        if (longBlocked) continue;
        m[label("MOMENTUM", c.s.coin)] = { desc: `#${i + 1} momentum, 7d ${r2(c.s.ret7dPct, 0)}%`, intent: { kind: "open", instId: c.s.instId, side: "long", lens: "momentum", sizeFrac: MOMENTUM_ENTRY_FRAC, setup: "strict" } };
      }
    }

    // Per position: close, add, trim, flip.
    for (const p of positionList(agent)) {
      const s = ctx.view.stats.get(p.instId);
      const inst = ctx.view.instruments.get(p.instId);
      const committed = p.lens === "momentum" && minutesSince(p.openedAt, ctx.now) < MOMENTUM_MIN_HOLD_MIN;
      if (!committed) m[label("CLOSE", p.coin)] = { desc: `exit ${p.side} ${p.coin}`, intent: { kind: "close", instId: p.instId, reason: "jev_close" } };
      if (!s || !inst) continue;
      const notional = positionNotional(p, s.mid, inst.ctVal);
      const room = notional < maxPositionNotionalUsd(ctx) * 0.95;
      const r = uplR(p, ctx) ?? 0;
      if (room && r > 1) m[label("ADD", p.coin)] = { desc: "add to this winner", intent: { kind: "add", instId: p.instId, sizeFrac: p.lens === "trend" ? 1 / 9 : ADD_FRAC } };
      if (p.lens === "trend" && s.trend && p.entryScore !== undefined) {
        const dir = p.side === "long" ? 1 : -1;
        if (dir * s.trend.score <= dir * p.entryScore - 3) m[label("TRIM", p.coin)] = { desc: "take half off", intent: { kind: "trim", instId: p.instId, fraction: 0.5 } };
      }
      const flip: Side = p.side === "long" ? "short" : "long";
      const trendFlip = p.lens === "trend" && s.trend && Math.sign(s.trend.score) === (flip === "long" ? 1 : -1) && Math.abs(s.trend.score) >= TREND_MIN_SCORE;
      const momFlip = p.lens === "momentum" && !committed && p.side === "long" && (s.ret1hPct ?? 0) < 0 && (s.oiChg1hPct ?? 0) < 0;
      if (trendFlip || momFlip) {
        m[label(`FLIP_${flip.toUpperCase()}`, p.coin)] = { desc: "reverse this position", intent: { kind: "flip", instId: p.instId, side: flip, lens: p.lens, sizeFrac: p.lens === "trend" ? trendSizeFrac(s, ctx) : MOMENTUM_ENTRY_FRAC } };
      }
    }

    if (Object.keys(m).length) m.HOLD = { desc: positionList(agent).length ? "keep the book as it is" : "nothing worth opening, wait", intent: { kind: "hold" } };
    return m;
  },

  stopFor(instId, side, lens, entryPx, ctx) {
    const s = ctx.view.stats.get(instId);
    if (lens === "breakout") return side === "long" ? (s?.breakout?.dayOpen ?? atrStop(s, side, entryPx, ctx.cfg.risk.stopAtrMult)) : atrStop(s, side, entryPx, ctx.cfg.risk.stopAtrMult);
    if (lens === "trend" && s?.trend && s.trend.atr4hPct !== null) {
      const dist = entryPx * (s.trend.atr4hPct / 100) * ctx.cfg.risk.stopAtrMult;
      return side === "long" ? entryPx - dist : entryPx + dist;
    }
    const atr = atr1hPx(s);
    if (lens === "momentum" && atr !== null) return side === "long" ? entryPx - TRAIL_ATR1H * atr : entryPx + TRAIL_ATR1H * atr;
    return atrStop(s, side, entryPx, ctx.cfg.risk.stopAtrMult);
  },

  trail(p, ctx) {
    const s = ctx.view.stats.get(p.instId);
    if (!s) return null;
    if (p.lens === "trend") {
      const t = s.trend;
      if (!t || t.trailStop === null) return null;
      return (p.side === "long" && t.score > 0) || (p.side === "short" && t.score < 0) ? t.trailStop : null;
    }
    if (p.lens === "momentum") {
      const atr = atr1hPx(s);
      return atr === null ? null : p.side === "long" ? s.mid - TRAIL_ATR1H * atr : s.mid + TRAIL_ATR1H * atr;
    }
    return null;
  },

  timeStopMinutes(p: Position) {
    return p.lens === "breakout" ? Math.max(1, (nextUtcMidnight(p.openedAt) - 60_000 - p.openedAt) / 60_000) : Number.POSITIVE_INFINITY;
  },

  idleStatus(ctx) {
    const next = byCoin(ctx, ctx.cfg.strategy.breakoutCoins)
      .map((s) => ({ coin: s.coin, pct: toTrigger(s) }))
      .filter((x): x is { coin: string; pct: number } => x.pct !== null)
      .sort((a, b) => a.pct - b.pct)[0];
    return next ? `watching: ${next.coin} is ${next.pct.toFixed(2)}% from breakout, no trend or momentum setup` : "watching: no setup on any lens";
  },
};

export type { Intent, Lens };
