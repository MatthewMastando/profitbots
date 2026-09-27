// Volume / market profile on synthetic candles.
import { describe, expect, it } from "vitest";
import { acceptanceBars, buildProfile, profileStats, vaPosition } from "../src/market/profile.js";
import type { Candle } from "../src/market/types.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 8, 24, 0, 0, 0);
const bar = (ts: number, lo: number, hi: number, vol: number, confirmed = true): Candle => ({ ts, o: (lo + hi) / 2, h: hi, l: lo, c: (lo + hi) / 2, volUsd: vol, confirmed });

/** 5 bars covering 90..110 thinly, 20 bars stacked at 99..101: POC ~100, value area tight around it. */
function stacked(): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < 5; i++) out.push(bar(T0 + i * H, 90, 110, 100));
  for (let i = 5; i < 25; i++) out.push(bar(T0 + i * H, 99, 101, 1000));
  return out;
}

describe("buildProfile", () => {
  it("puts the POC in the busiest bin and the 70% value area around it", () => {
    const p = buildProfile(stacked(), 100)!;
    expect(p.poc).toBeGreaterThan(99);
    expect(p.poc).toBeLessThan(101);
    expect(p.val).toBeGreaterThanOrEqual(98.5);
    expect(p.vah).toBeLessThanOrEqual(101.5);
    expect(p.val).toBeLessThan(p.poc);
    expect(p.vah).toBeGreaterThan(p.poc);
    expect(p.totalVolUsd).toBe(5 * 100 + 20 * 1000);
  });

  it("spreads a bar's volume across every bin it covers", () => {
    const c = [...Array.from({ length: 12 }, (_, i) => bar(T0 + i * H, 100, 110, 100))];
    const p = buildProfile(c, 105, 10)!;
    // Uniform volume: value area is 70% of the range, wherever the tie-break puts the POC.
    expect(p.vah - p.val).toBeCloseTo(7, 5);
  });

  it("finds low-volume nodes above and below price", () => {
    // Heavy at 99..101 and at 109..111, thin in between.
    const c: Candle[] = [];
    for (let i = 0; i < 10; i++) c.push(bar(T0 + i * H, 99, 101, 1000));
    for (let i = 10; i < 20; i++) c.push(bar(T0 + i * H, 109, 111, 1000));
    c.push(bar(T0 + 20 * H, 101, 109, 10));
    c.push(bar(T0 + 21 * H, 101, 109, 10));
    const below = buildProfile(c, 110)!;
    expect(below.lvnBelow).not.toBeNull();
    expect(below.lvnBelow!).toBeGreaterThan(101);
    expect(below.lvnBelow!).toBeLessThan(109);
    const above = buildProfile(c, 100)!;
    expect(above.lvnAbove).not.toBeNull();
    expect(above.lvnAbove!).toBeGreaterThan(101);
    expect(above.lvnAbove!).toBeLessThan(109);
  });

  it("needs a dozen bars, a real range and some volume", () => {
    expect(buildProfile(stacked().slice(0, 5), 100)).toBeNull();
    expect(buildProfile(Array.from({ length: 20 }, (_, i) => bar(T0 + i * H, 100, 100, 10)), 100)).toBeNull();
    expect(buildProfile(Array.from({ length: 20 }, (_, i) => bar(T0 + i * H, 99, 101, 0)), 100)).toBeNull();
  });
});

describe("value-area position and acceptance", () => {
  const p = { poc: 100, vah: 105, val: 95, step: 0.5, lvnAbove: null, lvnBelow: null, totalVolUsd: 1, bars: 20 };

  it("vaPosition is 0 at VAL, 1 at VAH, outside [0,1] beyond", () => {
    expect(vaPosition(95, p)).toBe(0);
    expect(vaPosition(105, p)).toBe(1);
    expect(vaPosition(110, p)).toBe(1.5);
    expect(vaPosition(90, p)).toBe(-0.5);
  });

  it("counts consecutive confirmed closes outside value, latest first, ignoring the forming bar", () => {
    const closes = (cs: Array<[number, boolean]>): Candle[] => cs.map(([c, ok], i) => ({ ts: T0 + i * H, o: c, h: c, l: c, c, volUsd: 1, confirmed: ok }));
    expect(acceptanceBars(closes([[100, true], [106, true], [107, true], [108, false]]), p)).toBe(2);
    expect(acceptanceBars(closes([[106, true], [100, true], [94, true], [93, true]]), p)).toBe(-2);
    expect(acceptanceBars(closes([[106, true], [100, true]]), p)).toBe(0);
    expect(acceptanceBars(closes([[106, true], [94, true]]), p)).toBe(-1);
  });
});

describe("profileStats", () => {
  it("builds the composite, yesterday's profile and the open-vs-value relation", () => {
    const c1h: Candle[] = [];
    // Yesterday: 24 bars centred on 100. Today: 6 bars opening at 108 (above yesterday's value).
    for (let i = 0; i < 24; i++) c1h.push(bar(T0 - 24 * H + i * H, 98, 102, 1000));
    for (let i = 0; i < 6; i++) c1h.push(bar(T0 + i * H, 107, 109, 500));
    const c15 = Array.from({ length: 8 }, (_, i) => bar(T0 + 4 * H + i * 15 * 60_000, 107.5, 108.5, 100));
    const s = profileStats(c15, c1h, 108, T0 + 6 * H)!;
    expect(s.prevDay).not.toBeNull();
    expect(s.prevDay!.poc).toBeCloseTo(100, 0);
    expect(s.openVsPrevVa).toBe("above");
    expect(s.composite.totalVolUsd).toBe(24 * 1000 + 6 * 500);
    expect(s.vaPos).toBeGreaterThan(0);
    expect(s.acceptance).toBeGreaterThan(0); // every 15m bar closed above the composite VAH
  });

  it("is null without enough 1h history", () => {
    expect(profileStats([], [bar(T0, 99, 101, 1)], 100, T0)).toBeNull();
  });
});
