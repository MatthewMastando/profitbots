// The one agent's brain: ICT and volume-profile lenses feed a single Jev menu. Jev picks the move that it believes
// makes the most money; deterministic code (risk.ts) sizes it, caps it and manages every stop.
import type { CoinStats } from "../market/types.js";
import { atrStop, maxPositionNotionalUsd, minutesSince, positionNotional, r2, uplR } from "./common.js";
import { positionList, type AgentContext, type Brain, type EntryMeta, type Intent, type Lens, type Menu, type MenuOption, type Position, type Side } from "./types.js";

/** ICT entries run tight stops (sweep wick / order block), so they take half the per-position cap. */
const ICT_ENTRY_FRAC = 0.5;
/** Value-area rotations aim at the POC; acceptance trades ride the breakout with a wider stop. */
const VP_ROTATION_FRAC = 0.5;
const VP_ACCEPT_FRAC = 0.75;
const ADD_FRAC = 0.25;
/** Confirmed 15m closes outside value before a breakout counts as accepted. */
export const ACCEPT_BARS = 2;
/** After this many 15m bars outside value the breakout is old news, not an entry (the profile will re-centre). */
export const ACCEPT_MAX_BARS = 16;
/** How close (fraction of the value-area width) price must be to VAL/VAH for a rotation. */
const EDGE_BAND = 0.12;
/** A zone counts as "at price" when last is inside it, padded by this fraction of price. */
const ZONE_PAD = 0.001;
/** Lens time stops: ICT is an intraday model, profile trades may run a couple of sessions. */
export const ICT_MAX_HOLD_MIN = 12 * 60;
export const VP_MAX_HOLD_MIN = 48 * 60;
/** Long veto when 30-day funding z is stretched (crowded long). */
export const FUNDING_Z_BLOCK_LONG = 1.5;

export const PROFIT_LOCK = [
  { atPct: 2.5, keep: 0.5 },
  { atPct: 5, keep: 0.65 },
] as const;

const atr15Px = (s: CoinStats | undefined) => (s && s.atr14Pct !== null ? (s.mid * s.atr14Pct) / 100 : null);
const label = (verb: string, coin: string) => `${verb}_${coin.replace(/[^A-Z0-9]/gi, "")}`;
const inZone = (px: number, z: { lo: number; hi: number }) => px >= z.lo * (1 - ZONE_PAD) && px <= z.hi * (1 + ZONE_PAD);
const pct = (from: number, to: number) => ((to - from) / from) * 100;

export interface Setup {
  key: string;
  opt: MenuOption;
  /** Ranking score: bigger is a better-looking trade. */
  score: number;
  s: CoinStats;
}

function open(s: CoinStats, side: Side, lens: Lens, sizeFrac: number, strict: boolean, meta: EntryMeta): Intent {
  return { kind: "open", instId: s.instId, side, lens, sizeFrac, setup: strict ? "strict" : "loose", meta };
}

/**
 * ICT: trade with the 1h structure bias after the 15m chart sweeps liquidity and displaces through structure,
 * entering when price returns to the fair value gap / order block the displacement left behind.
 */
export function ictSetups(s: CoinStats): Setup[] {
  const i = s.ict;
  if (!i || !i.displacement || i.bias === 0 || i.bias !== i.displacement.dir) return [];
  const d = i.displacement;
  const side: Side = d.dir === 1 ? "long" : "short";
  const zone = i.fvg ?? i.orderBlock;
  if (!zone) return [];
  const sweep = i.sweep && i.sweep.kind === (d.dir === 1 ? "low" : "high") && i.sweep.barsAgo >= d.barsAgo ? i.sweep : null;
  const discount = i.rangePos !== null && (d.dir === 1 ? i.rangePos <= 0.5 : i.rangePos >= 0.5);
  const atZone = inZone(s.mid, zone);
  const strict = atZone || (discount && sweep !== null);
  const setup = sweep ? "sweep_fvg" : "ob_retest";
  const kz = i.killzone ? 0.5 : 0;
  const score = d.atrMult + (sweep ? 1 : 0) + kz + (atZone ? 0.5 : 0);
  const where = atZone ? "at the zone" : `${Math.abs(pct(s.mid, d.dir === 1 ? zone.hi : zone.lo)).toFixed(2)}% from zone`;
  const desc = `${sweep ? `swept ${sweep.kind === "low" ? "lows" : "highs"}, ` : ""}displaced ${d.atrMult.toFixed(1)} ATR${i.killzone ? `, ${i.killzone}` : ""}, ${where}`;
  return [{ key: label(`ICT_${side.toUpperCase()}`, s.coin), score, s, opt: { desc, intent: open(s, side, "ict", ICT_ENTRY_FRAC, strict, { setup, targetPx: null }) } }];
}

/**
 * Volume profile: fade the value-area edges back to the POC while price is still inside value (rotation, incl. the
 * 80% rule off yesterday's value), or go with a breakout once two 15m bars have closed outside value (acceptance).
 */
export function vpSetups(s: CoinStats): Setup[] {
  const v = s.vp;
  if (!v) return [];
  const c = v.composite;
  const out: Setup[] = [];
  const atr = atr15Px(s);
  const rr = (target: number) => (atr ? Math.min(6, Math.abs(target - s.mid) / (2 * atr)) : 1);

  if (v.acceptance === 0) {
    if (v.vaPos >= -EDGE_BAND && v.vaPos <= EDGE_BAND) {
      out.push({ key: label("VP_ROTATION_LONG", s.coin), score: rr(c.poc), s, opt: { desc: `at VAL, POC ${pct(s.mid, c.poc).toFixed(2)}% above`, intent: open(s, "long", "vprofile", VP_ROTATION_FRAC, true, { setup: "rotation", targetPx: c.poc }) } });
    } else if (v.vaPos >= 1 - EDGE_BAND && v.vaPos <= 1 + EDGE_BAND) {
      out.push({ key: label("VP_ROTATION_SHORT", s.coin), score: rr(c.poc), s, opt: { desc: `at VAH, POC ${pct(s.mid, c.poc).toFixed(2)}% below`, intent: open(s, "short", "vprofile", VP_ROTATION_FRAC, true, { setup: "rotation", targetPx: c.poc }) } });
    }
    const pd = v.prevDay;
    if (pd && v.openVsPrevVa && v.openVsPrevVa !== "inside" && s.mid > pd.val && s.mid < pd.vah) {
      const side: Side = v.openVsPrevVa === "below" ? "long" : "short";
      const target = side === "long" ? pd.vah : pd.val;
      out.push({ key: label(`VP_RULE80_${side.toUpperCase()}`, s.coin), score: rr(target), s, opt: { desc: `opened ${v.openVsPrevVa} yesterday's value, back inside; ${side} to the far edge ${pct(s.mid, target).toFixed(2)}% away`, intent: open(s, side, "vprofile", VP_ROTATION_FRAC, true, { setup: "rule80", targetPx: target }) } });
    }
  } else if (Math.abs(v.acceptance) <= ACCEPT_MAX_BARS) {
    const side: Side = v.acceptance > 0 ? "long" : "short";
    const n = Math.abs(v.acceptance);
    const target = side === "long" ? c.lvnAbove : c.lvnBelow;
    const strict = n >= ACCEPT_BARS;
    out.push({ key: label(`VP_ACCEPT_${side.toUpperCase()}`, s.coin), score: 1 + Math.min(n, 6) * 0.5, s, opt: { desc: `${n} bar${n === 1 ? "" : "s"} accepted ${side === "long" ? "above VAH" : "below VAL"}${target ? `, next thin zone ${pct(s.mid, target).toFixed(2)}% away` : ""}`, intent: open(s, side, "vprofile", VP_ACCEPT_FRAC, strict, { setup: "acceptance", targetPx: target }) } });
  }
  return out;
}

/** Every open-setup on the gated universe, best first, funding-crowded longs and held coins removed. */
export function rankSetups(ctx: AgentContext): Setup[] {
  const out: Setup[] = [];
  for (const id of ctx.view.gated) {
    const s = ctx.view.stats.get(id);
    if (!s || ctx.agent.positions[id] || s.spreadBp > ctx.cfg.risk.spreadGateBps) continue;
    for (const x of [...ictSetups(s), ...vpSetups(s)]) {
      const longBlocked = x.opt.intent.kind === "open" && x.opt.intent.side === "long" && s.fundingZ !== null && s.fundingZ > FUNDING_Z_BLOCK_LONG;
      if (!longBlocked) out.push(x);
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** VP target hit: price traded through the setup's target in the position's favour. */
export function targetReached(p: Position, mid: number): boolean {
  if (p.targetPx === null || p.targetPx === undefined) return false;
  return p.side === "long" ? mid >= p.targetPx : mid <= p.targetPx;
}

export const brain: Brain = {
  strategy:
    "You are one trading agent running a leveraged futures book (crypto, metals, energy and equity-index contracts). Your only goal is to maximise total profit after fees. " +
    "Two lenses feed your menu. ICT: trade with the 1h structure bias after a 15m liquidity sweep and a displacement candle, entering at the fair value gap or order block it left; killzones (London 07-10, NY 12-15 and 18:30-20 UTC) are the best windows. " +
    "VOLUME PROFILE: rotations fade the value-area edge (VAL/VAH) back to the POC while price is still inside value; acceptance trades go with a breakout after two 15m closes outside value; the 80% rule trades back across yesterday's value after an open outside it. " +
    "You may hold several positions at once; the code caps total exposure and manages every stop. " +
    "Open only when the setup is real and the expected move pays for fees; ADD only to winners; TRIM when a target is reached; CLOSE what is failing; HOLD when nothing is clearly better. " +
    "Prefer fewer, better trades over churn.",
  convictionLabels: ["weak", "fair", "strong", "overwhelming"],
  profitLock: PROFIT_LOCK,

  snapshotCoins(ctx) {
    const ids = new Set<string>();
    for (const x of rankSetups(ctx).slice(0, ctx.cfg.strategy.maxMenuSetups)) ids.add(x.s.instId);
    for (const p of positionList(ctx.agent)) ids.add(p.instId);
    const byCoin = new Map([...ctx.view.stats.values()].map((s) => [s.coin, s.instId]));
    for (const c of ctx.cfg.strategy.watchCoins) {
      const id = byCoin.get(c);
      if (id) ids.add(id);
    }
    return [...ids];
  },

  coinSnapshot(s, ctx) {
    const p = ctx.agent.positions[s.instId];
    const i = s.ict;
    const v = s.vp;
    const zone = i?.fvg ?? i?.orderBlock ?? null;
    return {
      held: p ? `${p.side} ${p.lens}${p.setup ? ` ${p.setup}` : ""}` : null,
      upl_r: p ? r2(uplR(p, ctx), 1) : null,
      held_min: p ? r2(minutesSince(p.openedAt, ctx.now), 0) : null,
      bias_1h: i ? i.bias : null,
      sweep: i?.sweep ? `${i.sweep.kind} ${i.sweep.barsAgo}b ago` : null,
      disp_atr: i?.displacement ? r2(i.displacement.dir * i.displacement.atrMult, 1) : null,
      zone_pct: zone ? r2(pct(s.mid, (zone.lo + zone.hi) / 2)) : null,
      range_pos: r2(i?.rangePos ?? null),
      killzone: i?.killzone ?? null,
      va_pos: v ? r2(v.vaPos) : null,
      accepted: v ? v.acceptance : null,
      poc_pct: v ? r2(pct(s.mid, v.composite.poc)) : null,
      open_vs_pdva: v?.openVsPrevVa ?? null,
      r1h_pct: r2(s.ret1hPct, 1),
      r24h_pct: r2(s.ret24hPct, 1),
      rsi: r2(s.rsi14, 0),
      atr_pct: r2(s.atr14Pct),
      fund_z: r2(s.fundingZ, 1),
      spread_bp: r2(s.spreadBp, 0),
    };
  },

  menu(ctx) {
    const m: Menu = {};
    const { agent, cfg } = ctx;
    const capacity = cfg.risk.maxPositions === 0 || positionList(agent).length < cfg.risk.maxPositions;

    if (capacity) for (const x of rankSetups(ctx).slice(0, cfg.strategy.maxMenuSetups)) m[x.key] = x.opt;

    // Per position: close, add, trim, flip.
    for (const p of positionList(agent)) {
      const s = ctx.view.stats.get(p.instId);
      const inst = ctx.view.instruments.get(p.instId);
      m[label("CLOSE", p.coin)] = { desc: `exit ${p.side} ${p.coin}`, intent: { kind: "close", instId: p.instId, reason: "jev_close" } };
      if (!s || !inst) continue;
      const notional = positionNotional(p, s.mid, inst.ctVal);
      const room = notional < maxPositionNotionalUsd(ctx) * 0.95;
      const r = uplR(p, ctx) ?? 0;
      if (room && r > 1) m[label("ADD", p.coin)] = { desc: "add to this winner", intent: { kind: "add", instId: p.instId, sizeFrac: ADD_FRAC } };
      if (targetReached(p, s.mid)) m[label("TRIM", p.coin)] = { desc: "target reached, take half off", intent: { kind: "trim", instId: p.instId, fraction: 0.5 } };
      const flip: Side = p.side === "long" ? "short" : "long";
      const against = flip === "long" ? 1 : -1;
      const ictFlip = p.lens === "ict" && s.ict?.displacement?.dir === against && s.ict.bias === against;
      const vpFlip = p.lens === "vprofile" && s.vp !== null && Math.sign(s.vp.acceptance) === against && Math.abs(s.vp.acceptance) >= ACCEPT_BARS;
      if (ictFlip || vpFlip) {
        const meta: EntryMeta = ictFlip ? { setup: "ob_retest", targetPx: null } : { setup: "acceptance", targetPx: (against === 1 ? s.vp?.composite.lvnAbove : s.vp?.composite.lvnBelow) ?? null };
        m[label(`FLIP_${flip.toUpperCase()}`, p.coin)] = { desc: ictFlip ? "structure shifted against this, reverse" : "accepted outside value against this, reverse", intent: { kind: "flip", instId: p.instId, side: flip, lens: p.lens, sizeFrac: ictFlip ? ICT_ENTRY_FRAC : VP_ACCEPT_FRAC, meta } };
      }
    }

    if (Object.keys(m).length) m.HOLD = { desc: positionList(agent).length ? "keep the book as it is" : "nothing worth opening, wait", intent: { kind: "hold" } };
    return m;
  },

  stopFor(instId, side, lens, entryPx, ctx) {
    const s = ctx.view.stats.get(instId);
    const fallback = atrStop(s, side, entryPx, ctx.cfg.risk.stopAtrMult);
    if (!s) return fallback;
    const pad = entryPx * ZONE_PAD;
    if (lens === "ict" && s.ict) {
      const i = s.ict;
      const zone = i.orderBlock ?? i.fvg;
      const candidates = side === "long" ? [i.sweep?.kind === "low" ? i.sweep.extreme : null, zone?.lo ?? null] : [i.sweep?.kind === "high" ? i.sweep.extreme : null, zone?.hi ?? null];
      const lvls = candidates.filter((x): x is number => x !== null && (side === "long" ? x < entryPx : x > entryPx));
      if (lvls.length) return side === "long" ? Math.min(...lvls) - pad : Math.max(...lvls) + pad;
      return fallback;
    }
    if (lens === "vprofile" && s.vp) {
      const c = s.vp.composite;
      const width = c.vah - c.val;
      // Rotation: just outside the value edge; acceptance: back inside value = failed breakout.
      const edge = side === "long" ? (s.vp.acceptance > 0 ? c.vah - EDGE_BAND * width : c.val - EDGE_BAND * width) : s.vp.acceptance < 0 ? c.val + EDGE_BAND * width : c.vah + EDGE_BAND * width;
      const ok = side === "long" ? edge < entryPx : edge > entryPx;
      if (!ok) return fallback;
      if (fallback === null) return edge;
      // Never wider than the ATR stop.
      return side === "long" ? Math.max(edge, fallback) : Math.min(edge, fallback);
    }
    return fallback;
  },

  trail(p, ctx) {
    const s = ctx.view.stats.get(p.instId);
    if (!s) return null;
    if (p.lens === "ict" && s.ict) {
      const lvl = p.side === "long" ? s.ict.swingLow : s.ict.swingHigh;
      if (lvl === null) return null;
      return p.side === "long" ? (lvl < s.mid ? lvl : null) : lvl > s.mid ? lvl : null;
    }
    if (p.lens === "vprofile" && s.vp && p.setup === "acceptance") {
      // Once accepted outside value, trail behind the edge we broke.
      const c = s.vp.composite;
      const lvl = p.side === "long" ? c.vah : c.val;
      return p.side === "long" ? (lvl < s.mid ? lvl : null) : lvl > s.mid ? lvl : null;
    }
    return null;
  },

  timeStopMinutes(p: Position) {
    return p.lens === "ict" ? ICT_MAX_HOLD_MIN : VP_MAX_HOLD_MIN;
  },

  idleStatus(ctx) {
    const n = ctx.view.gated.length;
    const loose = rankSetups(ctx).find((x) => x.opt.intent.kind === "open" && x.opt.intent.setup === "loose");
    return loose ? `watching ${n} markets: ${loose.key.toLowerCase()} forming (${loose.opt.desc})` : `watching ${n} markets: no ICT or profile setup`;
  },
};

export type { Intent, Lens };
