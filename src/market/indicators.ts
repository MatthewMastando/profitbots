// Hand-rolled indicators on X-Perp candles (the kit's indicator tools are only documented for SWAP/SPOT ids).
// All inputs are oldest-first. Each function returns null when there is not enough data.

import type { Candle } from "./types.js";

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

/** Wilder RSI. */
export function rsi(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/** MACD(12,26,9). Returns the latest line, signal and histogram. */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): { line: number; signal: number; hist: number } | null {
  if (closes.length < slow + signal) return null;
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => f[i]! - s[i]!);
  const sig = ema(line.slice(slow - 1), signal);
  const l = line[line.length - 1]!;
  const sg = sig[sig.length - 1]!;
  return { line: l, signal: sg, hist: l - sg };
}

/** Wilder ATR, in price units. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const pc = candles[i - 1]!.c;
    tr.push(Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc)));
  }
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]!) / period;
  return a;
}

/** Bollinger(20, 2σ) on typical price (as in BbandRsi). %B is 0 at the lower band and 1 at the upper band. */
export function bollinger(candles: Candle[], period = 20, k = 2): { mid: number; upper: number; lower: number; pctB: number; widthPct: number } | null {
  if (candles.length < period) return null;
  const tp = candles.slice(-period).map((c) => (c.h + c.l + c.c) / 3);
  const mid = tp.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(tp.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
  const upper = mid + k * sd;
  const lower = mid - k * sd;
  const close = candles[candles.length - 1]!.c;
  const pctB = upper === lower ? 0.5 : (close - lower) / (upper - lower);
  return { mid, upper, lower, pctB, widthPct: mid ? ((upper - lower) / mid) * 100 : 0 };
}

export function pctChange(from: number | undefined, to: number | undefined): number | null {
  if (from === undefined || to === undefined || !(from > 0)) return null;
  return ((to - from) / from) * 100;
}

export function zScore(latest: number, history: number[]): number | null {
  if (history.length < 5) return null;
  const m = history.reduce((a, b) => a + b, 0) / history.length;
  const sd = Math.sqrt(history.reduce((a, b) => a + (b - m) ** 2, 0) / history.length);
  if (sd === 0) return 0;
  return (latest - m) / sd;
}
