import type { Candle, FundingNow, Instrument, Ticker } from "./types.js";

/** Everything the market feed needs from an exchange's public API. */
export interface PublicApi {
  instruments(): Promise<Instrument[]>;
  tickers(): Promise<Map<string, Ticker>>;
  candles(instId: string, bar: "15m" | "1H" | "4H", limit: number): Promise<Candle[]>;
  /** USD open interest per instrument (empty when the venue has none). */
  openInterest(): Promise<Map<string, number>>;
  funding(instId: string): Promise<FundingNow>;
  fundingHistory(instId: string, limit: number): Promise<number[]>;
}
