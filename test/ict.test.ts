// ICT structure detection on synthetic 15m candles.
import { describe, expect, it } from "vitest";
import { findDisplacement, findFvg, findOrderBlock, findSweep, ictStats, killzone, prevDayRange, structureBias, swings } from "../src/market/ict.js";
import type { Candle } from "../src/market/types.js";

const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 8, 24, 0, 0, 0);
/** Candles from [o,h,l,c] rows, 15m apart, all confirmed. */
const bars = (rows: Array<[number, number, number, number]>, start = T0): Candle[] => rows.map(([o, h, l, c], i) => ({ ts: start + i * M15, o, h, l, c, volUsd: 1000, confirmed: true }));
/** A quiet range around 100 with a 1-wide body per bar. */
const flat = (n: number, px = 100): Array<[number, number, number, number]> => Array.from({ length: n }, (_, i) => (i % 2 ? [px + 0.5, px + 1, px - 1, px - 0.5] : [px - 0.5, px + 1, px - 1, px + 0.5]));

describe("swings and bias", () => {
  it("finds fractal highs and lows", () => {
    const c = bars([...flat(3), [100, 106, 99, 101], ...flat(3), [100, 101, 94, 100], ...flat(3)]);
    const sw = swings(c, 2);
    expect(sw).toEqual([{ i: 3, px: 106, kind: "high" }, { i: 7, px: 94, kind: "low" }]);
  });

  it("bias turns bullish on a close above the last swing high and bearish on a close below the last swing low", () => {
    const up = bars([...flat(4), [100, 106, 99, 101], ...flat(4), [101, 110, 100, 109], ...flat(4, 109)]);
    expect(structureBias(up, 2)).toBe(1);
    const down = bars([...flat(4), [100, 101, 94, 100], ...flat(4), [100, 100, 88, 89], ...flat(4, 89)]);
    expect(structureBias(down, 2)).toBe(-1);
    expect(structureBias(bars(flat(20)), 2)).toBe(0);
  });
});

describe("liquidity sweeps", () => {
  it("a wick through a prior swing low that closes back above it is a bullish sweep with the wick as the extreme", () => {
    const c = bars([...flat(4), [100, 101, 94, 100], ...flat(6), [100, 101, 92.5, 100.5], ...flat(2)]);
    expect(findSweep(c, { highs: [], lows: [] })).toEqual({ level: 94, kind: "low", barsAgo: 2, extreme: 92.5 });
  });

  it("uses the previous day's high as liquidity too, and a clean break (close beyond) is not a sweep", () => {
    const c = bars([...flat(6), [100, 108, 99, 103], ...flat(2)]);
    expect(findSweep(c, { highs: [107], lows: [] })).toEqual({ level: 107, kind: "high", barsAgo: 2, extreme: 108 });
    const broke = bars([...flat(6), [100, 108, 99, 107.5], ...flat(2, 107.5)]);
    expect(findSweep(broke, { highs: [107], lows: [] })).toBeNull();
  });

  it("only looks back RECENT_BARS", () => {
    const c = bars([...flat(4), [100, 101, 94, 100], ...flat(4), [100, 101, 92.5, 100.5], ...flat(30)]);
    expect(findSweep(c, { highs: [], lows: [] })).toBeNull();
  });
});

describe("displacement, FVG and order block", () => {
  // A quiet range, a swing high at 106, a pullback candle (the order block), then a 4-ATR up candle through 106
  // that leaves a gap between the pre-candle high and the post-candle low.
  const leg = bars([...flat(4), [100, 106, 99, 101], ...flat(4), [101, 101.5, 99, 99.5], [99.5, 112, 99.5, 111], [111, 114, 110, 113], ...flat(3, 113)]);
  const atrPx = 2;

  it("detects the displacement and which swing it broke", () => {
    const d = findDisplacement(leg, atrPx);
    expect(d).toMatchObject({ dir: 1, broke: 106, barsAgo: 4 });
    expect(d!.atrMult).toBeCloseTo(11.5 / 2);
  });

  it("a big candle that does not break structure is not a displacement; no ATR means no answer", () => {
    const noBreak = bars([...flat(6), [100, 104, 99.5, 103.5], ...flat(3, 103.5)]);
    expect(findDisplacement(noBreak, atrPx)).toBeNull();
    expect(findDisplacement(leg, null)).toBeNull();
  });

  it("finds the bullish FVG left behind and the last down candle before the move as the order block", () => {
    const d = findDisplacement(leg, atrPx)!;
    const di = leg.length - 1 - d.barsAgo;
    const fvg = findFvg(leg, 1, di - 1)!;
    expect(fvg.lo).toBe(101.5); // candle before the displacement's high
    expect(fvg.hi).toBe(110); // candle after the displacement's low
    expect(findOrderBlock(leg, d)).toMatchObject({ lo: 99, hi: 101.5, dir: 1 });
  });

  it("a gap that price has since traded through is filled and no longer offered", () => {
    const filled = [...leg, ...bars([[113, 113, 101, 102]], leg.at(-1)!.ts + M15)];
    const d = findDisplacement(filled, atrPx)!;
    expect(findFvg(filled, 1, filled.length - 1 - d.barsAgo - 1)).toBeNull();
  });

  it("the bearish mirror works", () => {
    const down = bars([...flat(4), [100, 101, 94, 99], ...flat(4), [99, 101, 98.5, 100.5], [100.5, 100.5, 88, 89], [89, 90, 86, 87], ...flat(3, 87)]);
    const d = findDisplacement(down, atrPx)!;
    expect(d).toMatchObject({ dir: -1, broke: 94 });
    expect(findFvg(down, -1, down.length - 1 - d.barsAgo - 1)).toMatchObject({ lo: 90, hi: 98.5, dir: -1 });
    expect(findOrderBlock(down, d)).toMatchObject({ lo: 98.5, hi: 101, dir: -1 });
  });
});

describe("killzones and previous day", () => {
  it("London, NY AM and NY PM in UTC, null elsewhere", () => {
    expect(killzone(Date.UTC(2026, 8, 24, 8, 0))).toBe("london");
    expect(killzone(Date.UTC(2026, 8, 24, 13, 30))).toBe("ny_am");
    expect(killzone(Date.UTC(2026, 8, 24, 19, 0))).toBe("ny_pm");
    expect(killzone(Date.UTC(2026, 8, 24, 18, 15))).toBeNull();
    expect(killzone(Date.UTC(2026, 8, 24, 3, 0))).toBeNull();
  });

  it("previous UTC day high/low from 1h bars", () => {
    const H = 3_600_000;
    const yday = Array.from({ length: 24 }, (_, i): [number, number, number, number] => [100, 100 + i, 90 + i, 100]);
    const c = bars(yday, T0 - 24 * H).map((x, i) => ({ ...x, ts: T0 - 24 * H + i * H }));
    expect(prevDayRange(c, T0 + 5 * H)).toEqual({ pdh: 123, pdl: 90 });
    expect(prevDayRange(c.slice(0, 3), T0 + 5 * H)).toBeNull();
  });

  it("ictStats stitches it together and reports the latest 15m swings", () => {
    const c15 = bars([...flat(4), [100, 106, 99, 101], ...flat(4), [101, 101.5, 98.5, 99.5], [99.5, 112, 99.5, 111], [111, 114, 110, 113], ...flat(3, 112)]);
    const s = ictStats(c15, bars(flat(30)), 2, 113, T0 + 13 * 3_600_000);
    expect(s.displacement).toMatchObject({ dir: 1 });
    expect(s.fvg).not.toBeNull();
    expect(s.orderBlock).not.toBeNull();
    expect(s.killzone).toBe("ny_am");
    expect(s.swingHigh).toBe(114);
    expect(s.swingLow).toBe(98.5);
    expect(s.rangePos).toBeGreaterThan(0.5);
  });
});
