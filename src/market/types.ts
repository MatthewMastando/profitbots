import type { IctStats } from "./ict.js";
import type { Kind } from "./kinds.js";
import type { ProfileStats } from "./profile.js";

export interface Instrument {
  instId: string;
  coin: string;
  kind: Kind;
  ctVal: number;
  lotSz: number;
  minSz: number;
  tickSz: number;
  state: string;
  /** Perpetual-style contract (no practical expiry). */
  perpetual: boolean;
  /** Expiry (ms) for dated contracts, null for perpetuals / unknown. */
  expiry: number | null;
}

export interface Ticker {
  instId: string;
  last: number;
  bid: number;
  ask: number;
  mid: number;
  spreadBp: number;
  vol24hUsd: number;
  open24h: number;
  ts: number;
}

/** Oldest first. `volUsd` is quote volume in USD. */
export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  volUsd: number;
  confirmed: boolean;
}

export interface FundingNow {
  rate: number;
  nextFundingTime: number;
}

/** Everything the snapshot builder and risk layer may know about one coin. Numbers only. */
export interface CoinStats {
  instId: string;
  coin: string;
  last: number;
  mid: number;
  bid: number;
  ask: number;
  spreadBp: number;
  vol24hUsd: number;
  // 15m bars
  rsi14: number | null;
  pctB: number | null;
  bbWidthPct: number | null;
  bbMid: number | null;
  atr14Pct: number | null;
  macdHistPct: number | null;
  ret1hPct: number | null;
  // 1h bars
  ret24hPct: number | null;
  ret7dPct: number | null;
  volZ: number | null;
  // funding + OI
  fundingPct: number | null;
  fundingZ: number | null;
  oiUsd: number | null;
  oiChg1hPct: number | null;
  // news (kit news module; null when unavailable)
  newsZ: number | null;
  sentiment: number | null;
  /** ICT structure: bias, sweep, displacement, FVG, order block, killzone (15m entries, 1h bias). */
  ict: IctStats | null;
  /** Volume profile: composite + previous-day POC / value area, acceptance outside value. */
  vp: ProfileStats | null;
}

export interface MarketView {
  ts: number;
  instruments: Map<string, Instrument>;
  tickers: Map<string, Ticker>;
  stats: Map<string, CoinStats>;
  /** Gated universe, ranked by 24h volume. */
  gated: string[];
  /** Coins that passed volume but failed the spread gate. */
  spreadBlocked: string[];
  newsAvailable: boolean;
}
