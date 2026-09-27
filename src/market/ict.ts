// ICT (Inner Circle Trader) structure on candles: swings, market-structure bias, liquidity sweeps, displacement,
// fair value gaps, order blocks and killzones. Pure functions; the brain turns these into a menu.
import type { Candle } from "./types.js";

export type Dir = 1 | -1;

export interface Swing {
  /** Index into the candle array. */
  i: number;
  px: number;
  kind: "high" | "low";
}

export interface Sweep {
  /** Which liquidity was taken: a swing/prior-day low (`low`, bullish) or high (`high`, bearish). */
  level: number;
  kind: "high" | "low";
  /** Bars since the sweep candle closed back inside. */
  barsAgo: number;
  /** Extreme of the sweep wick (where the stop belongs). */
  extreme: number;
}

export interface Zone {
  lo: number;
  hi: number;
  /** +1 bullish (support), -1 bearish (resistance). */
  dir: Dir;
  /** Bars since the zone formed. */
  barsAgo: number;
}

export interface Displacement {
  dir: Dir;
  barsAgo: number;
  /** Body size as a multiple of ATR. */
  atrMult: number;
  /** The swing it broke (market structure shift). */
  broke: number;
}

export interface IctStats {
  /** Higher-timeframe (1h) structure: +1 bullish (last shift up), -1 bearish, 0 unclear. */
  bias: Dir | 0;
  /** Latest sweep of a 15m swing or previous-day high/low within the lookback, else null. */
  sweep: Sweep | null;
  /** Latest displacement (body > k x ATR) that also shifted 15m structure. */
  displacement: Displacement | null;
  /** Nearest unfilled 15m fair value gap in the displacement direction. */
  fvg: Zone | null;
  /** The last opposing candle before the displacement. */
  orderBlock: Zone | null;
  /** Previous UTC day high/low. */
  pdh: number | null;
  pdl: number | null;
  /** Current killzone (UTC), or null outside them. */
  killzone: string | null;
  /** Where the last price sits in the displacement's dealing range: 0 = discount extreme, 1 = premium extreme. */
  rangePos: number | null;
  /** Most recent confirmed 15m swing high / low (structure trail). */
  swingHigh: number | null;
  swingLow: number | null;
}

const DAY = 86_400_000;
/** A displacement candle's body must be at least this many ATRs. */
export const DISPLACEMENT_ATR = 1.5;
/** How far back (bars) a sweep or displacement still counts as "recent". */
export const RECENT_BARS = 16;

/** Fractal swings: a high above `k` bars either side (resp. a low below). */
export function swings(c: Candle[], k = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true;
    let lo = true;
    for (let j = 1; j <= k && (hi || lo); j++) {
      if (!(c[i]!.h > c[i - j]!.h && c[i]!.h > c[i + j]!.h)) hi = false;
      if (!(c[i]!.l < c[i - j]!.l && c[i]!.l < c[i + j]!.l)) lo = false;
    }
    if (hi) out.push({ i, px: c[i]!.h, kind: "high" });
    if (lo) out.push({ i, px: c[i]!.l, kind: "low" });
  }
  return out;
}

/**
 * Structure bias from the latest break of structure: a close above the most recent swing high is bullish until a
 * close below the most recent swing low, and vice versa.
 */
export function structureBias(c: Candle[], k = 3): Dir | 0 {
  const sw = swings(c, k);
  let bias: Dir | 0 = 0;
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  let si = 0;
  for (let i = 0; i < c.length; i++) {
    while (si < sw.length && sw[si]!.i + k <= i) {
      const s = sw[si++]!;
      if (s.kind === "high") lastHigh = s;
      else lastLow = s;
    }
    const close = c[i]!.c;
    if (lastHigh && close > lastHigh.px) {
      bias = 1;
      lastHigh = null;
    } else if (lastLow && close < lastLow.px) {
      bias = -1;
      lastLow = null;
    }
  }
  return bias;
}

export function prevDayRange(c: Candle[], now: number): { pdh: number; pdl: number } | null {
  const t0 = Math.floor(now / DAY) * DAY;
  const prev = c.filter((x) => x.ts >= t0 - DAY && x.ts < t0);
  if (prev.length < 6) return null;
  return { pdh: Math.max(...prev.map((x) => x.h)), pdl: Math.min(...prev.map((x) => x.l)) };
}

/**
 * Most recent sweep in the last `recent` bars: a candle that trades through a prior swing (or the previous day's
 * high/low) and closes back on the original side, i.e. it took the stops and failed to continue.
 */
export function findSweep(c: Candle[], levels: { highs: number[]; lows: number[] }, recent = RECENT_BARS): Sweep | null {
  const sw = swings(c, 2);
  const start = Math.max(1, c.length - recent);
  let best: Sweep | null = null;
  for (let i = c.length - 1; i >= start; i--) {
    const x = c[i]!;
    const priorHighs = [...sw.filter((s) => s.kind === "high" && s.i + 2 < i).map((s) => s.px), ...levels.highs];
    const priorLows = [...sw.filter((s) => s.kind === "low" && s.i + 2 < i).map((s) => s.px), ...levels.lows];
    const sweptLow = priorLows.filter((l) => x.l < l && x.c > l).sort((a, b) => a - b)[0];
    const sweptHigh = priorHighs.filter((h) => x.h > h && x.c < h).sort((a, b) => b - a)[0];
    if (sweptLow !== undefined) best = { level: sweptLow, kind: "low", barsAgo: c.length - 1 - i, extreme: x.l };
    else if (sweptHigh !== undefined) best = { level: sweptHigh, kind: "high", barsAgo: c.length - 1 - i, extreme: x.h };
    if (best) return best;
  }
  return null;
}

/** Latest candle whose body is >= `mult` x ATR and whose close broke the nearest prior swing in its direction. */
export function findDisplacement(c: Candle[], atrPx: number | null, recent = RECENT_BARS, mult = DISPLACEMENT_ATR): Displacement | null {
  if (atrPx === null || !(atrPx > 0)) return null;
  const sw = swings(c, 2);
  const start = Math.max(1, c.length - recent);
  for (let i = c.length - 1; i >= start; i--) {
    const x = c[i]!;
    const body = x.c - x.o;
    if (Math.abs(body) < mult * atrPx) continue;
    const dir: Dir = body > 0 ? 1 : -1;
    const prior = sw.filter((s) => s.i + 2 < i && s.kind === (dir === 1 ? "high" : "low"));
    const nearest = prior.length ? prior[prior.length - 1]! : null;
    if (!nearest) continue;
    if ((dir === 1 && x.c > nearest.px && x.o <= nearest.px) || (dir === -1 && x.c < nearest.px && x.o >= nearest.px)) {
      return { dir, barsAgo: c.length - 1 - i, atrMult: Math.abs(body) / atrPx, broke: nearest.px };
    }
  }
  return null;
}

/**
 * Nearest unfilled fair value gap in `dir` since `sinceBar`: a three-candle imbalance where candle 1's high and
 * candle 3's low don't overlap (bullish) or candle 1's low and candle 3's high don't (bearish). Filled when price
 * has since traded back through the whole gap.
 */
export function findFvg(c: Candle[], dir: Dir, sinceBar: number): Zone | null {
  let best: Zone | null = null;
  for (let i = Math.max(2, sinceBar); i < c.length; i++) {
    const a = c[i - 2]!;
    const b = c[i]!;
    let lo: number;
    let hi: number;
    if (dir === 1) {
      if (!(b.l > a.h)) continue;
      lo = a.h;
      hi = b.l;
    } else {
      if (!(b.h < a.l)) continue;
      lo = b.h;
      hi = a.l;
    }
    const after = c.slice(i + 1);
    const filled = dir === 1 ? after.some((x) => x.l <= lo) : after.some((x) => x.h >= hi);
    if (filled) continue;
    best = { lo, hi, dir, barsAgo: c.length - 1 - i };
  }
  return best;
}

/** The last down candle before a bullish displacement (or up candle before a bearish one). */
export function findOrderBlock(c: Candle[], d: Displacement): Zone | null {
  const di = c.length - 1 - d.barsAgo;
  for (let i = di - 1; i >= Math.max(0, di - 6); i--) {
    const x = c[i]!;
    if ((d.dir === 1 && x.c < x.o) || (d.dir === -1 && x.c > x.o)) return { lo: x.l, hi: x.h, dir: d.dir, barsAgo: c.length - 1 - i };
  }
  return null;
}

/** ICT killzones in UTC: London open, New York AM and PM. */
export function killzone(now: number): string | null {
  const d = new Date(now);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m >= 7 * 60 && m < 10 * 60) return "london";
  if (m >= 12 * 60 && m < 15 * 60) return "ny_am";
  if (m >= 18 * 60 + 30 && m < 20 * 60) return "ny_pm";
  return null;
}

export function ictStats(c15: Candle[], c1h: Candle[], atr15Px: number | null, last: number, now: number): IctStats {
  const pd = prevDayRange(c1h, now);
  const sweep = findSweep(c15, { highs: pd ? [pd.pdh] : [], lows: pd ? [pd.pdl] : [] });
  const displacement = findDisplacement(c15, atr15Px);
  const di = displacement ? c15.length - 1 - displacement.barsAgo : 0;
  const fvg = displacement ? findFvg(c15, displacement.dir, Math.max(2, di - 1)) : null;
  const orderBlock = displacement ? findOrderBlock(c15, displacement) : null;
  let rangePos: number | null = null;
  if (displacement) {
    const leg = c15.slice(Math.max(0, di - RECENT_BARS), c15.length);
    const hi = Math.max(...leg.map((x) => x.h));
    const lo = Math.min(...leg.map((x) => x.l));
    rangePos = hi > lo ? (last - lo) / (hi - lo) : null;
  }
  const sw = swings(c15, 2);
  const lastOf = (kind: Swing["kind"]) => sw.filter((x) => x.kind === kind).at(-1)?.px ?? null;
  return {
    bias: structureBias(c1h),
    swingHigh: lastOf("high"),
    swingLow: lastOf("low"),
    sweep,
    displacement,
    fvg,
    orderBlock,
    pdh: pd?.pdh ?? null,
    pdl: pd?.pdl ?? null,
    killzone: killzone(now),
    rangePos,
  };
}
