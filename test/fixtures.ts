import type { AgentContext, AgentState, Position } from "../src/agent/types.js";
import { loadConfig, type Config } from "../src/config.js";
import { freshAgent } from "../src/ledger.js";
import type { IctStats } from "../src/market/ict.js";
import type { Profile, ProfileStats } from "../src/market/profile.js";
import type { CoinStats, Instrument, MarketView, Ticker } from "../src/market/types.js";

export const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ TYPESAFE_API_KEY: "test-key", ...env });
}

export const instIdFor = (coinName: string) => `${coinName}-PERP-INTX`;

export function coin(coinName: string, over: Partial<CoinStats> = {}, px = 100): CoinStats {
  return {
    instId: instIdFor(coinName),
    coin: coinName,
    last: px,
    mid: px,
    bid: px * 0.99995,
    ask: px * 1.00005,
    spreadBp: 1,
    vol24hUsd: 20e6,
    rsi14: 50,
    pctB: 0.5,
    bbWidthPct: 2,
    bbMid: px,
    atr14Pct: 0.5,
    macdHistPct: 0,
    ret1hPct: 0,
    ret24hPct: 0,
    ret7dPct: 0,
    volZ: 0,
    fundingPct: 0.01,
    fundingZ: 0,
    oiUsd: 1e6,
    oiChg1hPct: 0,
    newsZ: null,
    sentiment: null,
    ict: null,
    vp: null,
    ...over,
  };
}

/** A bullish ICT picture at price `px`: 1h bias up, lows swept, displacement, price sitting in the FVG. Pass dir -1 for the mirror. */
export function ict(px: number, dir: 1 | -1 = 1, over: Partial<IctStats> = {}): IctStats {
  const d = dir;
  return {
    bias: d,
    sweep: { level: px * (1 - d * 0.01), kind: d === 1 ? "low" : "high", barsAgo: 6, extreme: px * (1 - d * 0.012) },
    displacement: { dir: d, barsAgo: 3, atrMult: 2, broke: px * (1 + d * 0.005) },
    fvg: d === 1 ? { lo: px * 0.998, hi: px * 1.002, dir: d, barsAgo: 3 } : { lo: px * 0.998, hi: px * 1.002, dir: d, barsAgo: 3 },
    orderBlock: d === 1 ? { lo: px * 0.99, hi: px * 0.995, dir: d, barsAgo: 4 } : { lo: px * 1.005, hi: px * 1.01, dir: d, barsAgo: 4 },
    pdh: px * 1.03,
    pdl: px * 0.97,
    killzone: "ny_am",
    rangePos: d === 1 ? 0.3 : 0.7,
    swingHigh: px * 1.015,
    swingLow: px * 0.985,
    ...over,
  };
}

export function profile(poc: number, width: number, over: Partial<Profile> = {}): Profile {
  return { poc, vah: poc + width / 2, val: poc - width / 2, step: width / 20, lvnAbove: poc + width, lvnBelow: poc - width, totalVolUsd: 1e8, bars: 120, ...over };
}

/** Volume profile with the composite POC at `poc`, `width` wide; `vaPos`/`acceptance` describe where `px` is. */
export function vp(px: number, poc: number, width: number, over: Partial<ProfileStats> = {}): ProfileStats {
  const composite = profile(poc, width);
  return { composite, prevDay: null, vaPos: (px - composite.val) / width, acceptance: 0, openVsPrevVa: null, ...over };
}

export function instrument(s: CoinStats, over: Partial<Instrument> = {}): Instrument {
  // One contract is worth $1 at the fixture price, whatever the coin.
  return { instId: s.instId, coin: s.coin, kind: "crypto", ctVal: 1 / s.mid, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live", perpetual: true, expiry: null, ...over };
}

export function view(stats: CoinStats[], over: Partial<MarketView> = {}): MarketView {
  const instruments = new Map<string, Instrument>();
  const tickers = new Map<string, Ticker>();
  for (const s of stats) {
    instruments.set(s.instId, instrument(s));
    tickers.set(s.instId, { instId: s.instId, last: s.last, bid: s.bid, ask: s.ask, mid: s.mid, spreadBp: s.spreadBp, vol24hUsd: s.vol24hUsd, open24h: s.last, ts: NOW });
  }
  return {
    ts: NOW,
    instruments,
    tickers,
    stats: new Map(stats.map((s) => [s.instId, s])),
    gated: stats.map((s) => s.instId),
    spreadBlocked: [],
    newsAvailable: false,
    ...over,
  };
}

export function agent(over: Partial<AgentState> = {}, equity = 1000): AgentState {
  return { ...freshAgent(equity, NOW - 60 * 60_000), dayKey: "2026-09-24", ...over };
}

export function position(s: CoinStats, over: Partial<Position> = {}): Position {
  return {
    instId: s.instId,
    coin: s.coin,
    side: "long",
    lens: "ict",
    contracts: 100,
    entryPx: s.mid,
    openedAt: NOW - 10 * 60_000,
    stopPx: null,
    riskUsd: 10,
    initialStopPx: null,
    peakPx: null,
    feesUsd: 0,
    realisedUsd: 0,
    maxContracts: 100,
    ...over,
  };
}

export function withPositions(a: AgentState, ...ps: Position[]): AgentState {
  for (const p of ps) a.positions[p.instId] = p;
  a.flatSince = ps.length ? null : a.flatSince;
  return a;
}

export function ctx(a: AgentState, v: MarketView, cfg = testConfig(), now = NOW): AgentContext {
  return { agent: a, view: v, cfg, now };
}
