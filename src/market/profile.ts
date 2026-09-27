// Volume / market profile from candles: each bar's USD volume is spread evenly over its high-low range into price
// bins. POC = the busiest bin; value area = the bins around it that hold 70% of volume; HVN/LVN = local extremes.
import type { Candle } from "./types.js";

export interface Profile {
  poc: number;
  vah: number;
  val: number;
  /** Bin width in price. */
  step: number;
  /** Nearest low-volume node above/below the last price (thin spots price tends to move through quickly). */
  lvnAbove: number | null;
  lvnBelow: number | null;
  totalVolUsd: number;
  bars: number;
}

export interface ProfileStats {
  /** Composite of the last `COMPOSITE_BARS` 1h bars (~5 sessions). */
  composite: Profile;
  /** Previous UTC day's profile, when a full day is available. */
  prevDay: Profile | null;
  /** Where last sits relative to the composite value area: <0 below VAL, 0..1 inside, >1 above VAH. */
  vaPos: number;
  /** Consecutive closed 15m bars outside the composite value area: +n above VAH, -n below VAL, 0 inside. */
  acceptance: number;
  /** Today's opening price relative to yesterday's value area (80% rule setup), or null. */
  openVsPrevVa: "above" | "inside" | "below" | null;
}

export const COMPOSITE_BARS = 120;
export const VALUE_AREA = 0.7;
const BINS = 60;
const DAY = 86_400_000;

export function buildProfile(c: Candle[], last: number, bins = BINS): Profile | null {
  if (c.length < 12) return null;
  const hi = Math.max(...c.map((x) => x.h));
  const lo = Math.min(...c.map((x) => x.l));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array<number>(bins).fill(0);
  let total = 0;
  for (const x of c) {
    const v = Math.max(0, x.volUsd);
    if (!(v > 0)) continue;
    total += v;
    const b0 = Math.min(bins - 1, Math.floor((x.l - lo) / step));
    const b1 = Math.min(bins - 1, Math.floor((Math.max(x.l, x.h - 1e-12) - lo) / step));
    const per = v / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vol[b]! += per;
  }
  if (!(total > 0)) return null;
  // POC: the busiest bin; on a tie (flat profile) the middle of the tied bins.
  const max = Math.max(...vol);
  const tied = vol.map((v, b) => (v >= max * (1 - 1e-9) ? b : -1)).filter((b) => b >= 0);
  const pocBin = tied[Math.floor(tied.length / 2)]!;
  // Expand from the POC, taking the heavier neighbour, until 70% of volume is in.
  let a = pocBin;
  let z = pocBin;
  let inArea = vol[pocBin]!;
  while (inArea < VALUE_AREA * total && (a > 0 || z < bins - 1)) {
    const up = z < bins - 1 ? vol[z + 1]! : -1;
    const down = a > 0 ? vol[a - 1]! : -1;
    if (up >= down) {
      z++;
      inArea += up;
    } else {
      a--;
      inArea += down;
    }
  }
  const mid = (b: number) => lo + (b + 0.5) * step;
  const lastBin = Math.max(0, Math.min(bins - 1, Math.floor((last - lo) / step)));
  // LVN: a thin bin (under half the average) that is no busier than its neighbours.
  const isLvn = (b: number) => b > 0 && b < bins - 1 && vol[b]! <= vol[b - 1]! && vol[b]! <= vol[b + 1]! && vol[b]! < 0.5 * (total / bins);
  let lvnAbove: number | null = null;
  let lvnBelow: number | null = null;
  for (let b = lastBin + 1; b < bins; b++) {
    if (isLvn(b)) {
      lvnAbove = mid(b);
      break;
    }
  }
  for (let b = lastBin - 1; b >= 0; b--) {
    if (isLvn(b)) {
      lvnBelow = mid(b);
      break;
    }
  }
  return { poc: mid(pocBin), vah: lo + (z + 1) * step, val: lo + a * step, step, lvnAbove, lvnBelow, totalVolUsd: total, bars: c.length };
}

export function vaPosition(px: number, p: Profile): number {
  const w = p.vah - p.val;
  return w > 0 ? (px - p.val) / w : 0.5;
}

/** Consecutive confirmed bars (latest first) that closed above VAH (+) or below VAL (-). */
export function acceptanceBars(c15: Candle[], p: Profile): number {
  let n = 0;
  let dir = 0;
  for (let i = c15.length - 1; i >= 0; i--) {
    const x = c15[i]!;
    if (!x.confirmed) continue;
    const d = x.c > p.vah ? 1 : x.c < p.val ? -1 : 0;
    if (d === 0 || (dir !== 0 && d !== dir)) break;
    dir = d;
    n++;
  }
  return dir * n;
}

export function profileStats(c15: Candle[], c1h: Candle[], last: number, now: number): ProfileStats | null {
  const composite = buildProfile(c1h.slice(-COMPOSITE_BARS), last);
  if (!composite) return null;
  const t0 = Math.floor(now / DAY) * DAY;
  const prevBars = c1h.filter((x) => x.ts >= t0 - DAY && x.ts < t0);
  const prevDay = prevBars.length >= 20 ? buildProfile(prevBars, last, 40) : null;
  const todayOpen = c1h.find((x) => x.ts >= t0)?.o;
  let openVsPrevVa: ProfileStats["openVsPrevVa"] = null;
  if (prevDay && todayOpen !== undefined) openVsPrevVa = todayOpen > prevDay.vah ? "above" : todayOpen < prevDay.val ? "below" : "inside";
  return { composite, prevDay, vaPos: vaPosition(last, composite), acceptance: acceptanceBars(c15, composite), openVsPrevVa };
}
