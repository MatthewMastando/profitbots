// Public Coinbase Advanced Trade market data (Coinbase Derivatives futures), mapped onto the engine's PublicApi.
import { kindOf, type Kind } from "../market/kinds.js";
import type { PublicApi } from "../market/public-api.js";
import type { Candle, FundingNow, Instrument, Ticker } from "../market/types.js";
import { createCoinbaseRest, type CoinbaseRest } from "./rest.js";

export type { PublicApi } from "../market/public-api.js";

const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));

export interface CbProduct {
  product_id: string;
  display_name?: string;
  status?: string;
  trading_disabled?: boolean;
  is_disabled?: boolean;
  view_only?: boolean;
  fcm_trading_session_details?: { is_session_open?: boolean; session_state?: string } | null;
  price?: string;
  price_percentage_change_24h?: string;
  volume_24h?: string;
  approximate_quote_24h_volume?: string;
  base_increment?: string;
  quote_increment?: string;
  base_min_size?: string;
  product_type?: string;
  product_venue?: string;
  future_product_details?: {
    venue?: string;
    contract_code?: string;
    contract_expiry?: string;
    contract_size?: string;
    contract_root_unit?: string;
    contract_expiry_type?: string;
    perpetual_details?: { open_interest?: string; funding_rate?: string; funding_time?: string; max_leverage?: string } | null;
  };
}

export interface CbTicker {
  trades?: Array<{ price?: string; size?: string; time?: string }>;
  best_bid?: string;
  best_ask?: string;
}

export interface CbCandle {
  start: string;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

const TEN_YEARS_MS = 10 * 365 * 86_400_000;
const COMMODITY_WORDS = /\b(GOLD|SILVER|COPPER|OIL|CRUDE|NAT ?GAS|XAU|XAG)\b/i;
const EQUITY_WORDS = /\b(MAG ?7|SPX|S&P|NASDAQ|NDX|DOW|RUSSELL|EQUIT)/i;

/** Perpetual-style: Coinbase lists its perps as EXPIRING with a far-future expiry and a perpetual_details block. */
export function isPerpetual(p: CbProduct, now = Date.now()): boolean {
  const f = p.future_product_details;
  if (!f) return false;
  if (f.contract_expiry_type === "PERPETUAL" || f.perpetual_details) return true;
  const exp = Date.parse(f.contract_expiry ?? "");
  return Number.isFinite(exp) && exp - now > TEN_YEARS_MS;
}

/** Coin symbol: the contract's root unit, else the product id's first segment. */
export function coinOfProduct(p: CbProduct): string {
  const root = p.future_product_details?.contract_root_unit?.trim();
  if (root) return root.toUpperCase();
  const disp = p.display_name?.split(/\s+/)[0]?.trim();
  if (disp) return disp.toUpperCase();
  return p.product_id.split("-")[0]!.toUpperCase();
}

function kindOfProduct(p: CbProduct, coin: string): Kind {
  const name = `${p.display_name ?? ""} ${coin}`;
  if (COMMODITY_WORDS.test(name)) return "commodity";
  if (EQUITY_WORDS.test(name)) return "stock";
  const k = kindOf(coin);
  // Every Coinbase Derivatives perpetual-style contract is a crypto (or crypto index) product.
  return k === "unknown" && isPerpetual(p) ? "crypto" : k;
}

/**
 * Tradable right now. Futures rows come back with an empty `status`; the flags and the FCM session are what count.
 * A row that says `status: "online"` is live too (spot-style payloads).
 */
export function isTradable(p: CbProduct): boolean {
  if (p.trading_disabled || p.is_disabled || p.view_only) return false;
  const status = (p.status ?? "").toLowerCase();
  if (status && status !== "online") return false;
  const s = p.fcm_trading_session_details;
  if (s && (s.is_session_open === false || (s.session_state && s.session_state !== "FCM_TRADING_SESSION_STATE_OPEN"))) return false;
  return true;
}

export function parseProduct(p: CbProduct): Instrument {
  const coin = coinOfProduct(p);
  const f = p.future_product_details;
  const live = isTradable(p);
  const perpetual = isPerpetual(p);
  return {
    instId: p.product_id,
    coin,
    kind: kindOfProduct(p, coin),
    ctVal: num(f?.contract_size) || 1,
    lotSz: num(p.base_increment) || 1,
    minSz: num(p.base_min_size) || num(p.base_increment) || 1,
    tickSz: num(p.quote_increment) || 0.01,
    state: live ? "live" : (p.status || p.fcm_trading_session_details?.session_state || "suspended").toLowerCase(),
    perpetual,
    expiry: !perpetual && f?.contract_expiry ? Date.parse(f.contract_expiry) || null : null,
  };
}

/** Ticker from the product row (price, 24h volume) plus best bid/ask when we fetched them. */
export function parseTicker(p: CbProduct, t: CbTicker | null, ts: number): Ticker {
  const last = num(p.price) || num(t?.trades?.[0]?.price);
  const bid = num(t?.best_bid);
  const ask = num(t?.best_ask);
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  const ctVal = num(p.future_product_details?.contract_size) || 1;
  const quoteVol = num(p.approximate_quote_24h_volume);
  const vol24hUsd = Number.isFinite(quoteVol) && quoteVol > 0 ? quoteVol : num(p.volume_24h) * ctVal * last;
  const chg = num(p.price_percentage_change_24h);
  return {
    instId: p.product_id,
    last,
    bid,
    ask,
    mid,
    spreadBp: bid > 0 && ask > 0 ? ((ask - bid) / mid) * 10_000 : Infinity,
    vol24hUsd: Number.isFinite(vol24hUsd) ? vol24hUsd : 0,
    open24h: Number.isFinite(chg) ? last / (1 + chg / 100) : last,
    ts,
  };
}

export const GRANULARITY = { "15m": "FIFTEEN_MINUTE", "1H": "ONE_HOUR", "4H": "FOUR_HOUR" } as const;
export const BAR_MS = { "15m": 15 * 60_000, "1H": 3_600_000, "4H": 4 * 3_600_000 } as const;
/** Coinbase serves at most 350 candles per call. */
const MAX_CANDLES = 350;

export function parseCandles(rows: CbCandle[], barMs: number, ctVal: number, now: number): Candle[] {
  return rows
    .map((r) => {
      const ts = num(r.start) * 1000;
      const c = num(r.close);
      return { ts, o: num(r.open), h: num(r.high), l: num(r.low), c, volUsd: num(r.volume) * ctVal * c, confirmed: ts + barMs <= now };
    })
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.c))
    .sort((a, b) => a.ts - b.ts);
}

export const PUBLIC_TTL_MS = { products: 10_000, tickers: 900, candles: 10_000 } as const;
/** Best bid/ask is one call per product; cap how many products get one per tick (by 24h volume, perps first). */
const MAX_QUOTED = 40;

export interface PublicOpts {
  allowNonCrypto: boolean;
  now?: () => number;
}

export function createCoinbasePublic(rest: CoinbaseRest, opts: PublicOpts): PublicApi {
  const now = opts.now ?? Date.now;
  const products = () => rest.get<{ products: CbProduct[] }>("/api/v3/brokerage/market/products", { product_type: "FUTURE", get_all_products: true }, PUBLIC_TTL_MS.products).then((r) => r.products ?? []);

  /** The products we quote: live, perpetual (or any live contract when non-crypto is allowed), most traded first. */
  function quoted(ps: CbProduct[]): CbProduct[] {
    return ps
      .filter(isTradable)
      .filter((p) => isPerpetual(p, now()) || opts.allowNonCrypto)
      .sort((a, b) => (num(b.approximate_quote_24h_volume) || 0) - (num(a.approximate_quote_24h_volume) || 0))
      .slice(0, MAX_QUOTED);
  }

  return {
    async instruments() {
      return (await products()).map(parseProduct);
    },
    async tickers() {
      const ps = await products();
      const ts = now();
      const quotes = new Map<string, CbTicker | null>();
      await Promise.all(
        quoted(ps).map(async (p) => {
          const t = await rest.get<CbTicker>(`/api/v3/brokerage/market/products/${encodeURIComponent(p.product_id)}/ticker`, { limit: 1 }, PUBLIC_TTL_MS.tickers).catch(() => null);
          quotes.set(p.product_id, t);
        }),
      );
      const out = new Map<string, Ticker>();
      for (const p of ps) out.set(p.product_id, parseTicker(p, quotes.get(p.product_id) ?? null, ts));
      return out;
    },
    async candles(instId, bar, limit) {
      const n = Math.min(limit, MAX_CANDLES);
      const end = Math.floor(now() / 1000);
      const start = end - (n * BAR_MS[bar]) / 1000;
      const ps = await products();
      const ctVal = num(ps.find((p) => p.product_id === instId)?.future_product_details?.contract_size) || 1;
      const r = await rest.get<{ candles: CbCandle[] }>(`/api/v3/brokerage/market/products/${encodeURIComponent(instId)}/candles`, { start, end, granularity: GRANULARITY[bar], limit: n }, PUBLIC_TTL_MS.candles);
      return parseCandles(r.candles ?? [], BAR_MS[bar], ctVal, now());
    },
    async openInterest() {
      const out = new Map<string, number>();
      for (const p of await products()) {
        const oi = num(p.future_product_details?.perpetual_details?.open_interest);
        const px = num(p.price);
        const ctVal = num(p.future_product_details?.contract_size) || 1;
        if (Number.isFinite(oi) && Number.isFinite(px)) out.set(p.product_id, oi * ctVal * px);
      }
      return out;
    },
    async funding(instId) {
      const p = (await products()).find((x) => x.product_id === instId);
      const d = p?.future_product_details?.perpetual_details;
      const rate = num(d?.funding_rate);
      return { rate: Number.isFinite(rate) ? rate : NaN, nextFundingTime: Date.parse(d?.funding_time ?? "") || NaN } satisfies FundingNow;
    },
    async fundingHistory() {
      // No public funding-history endpoint is documented for Coinbase Derivatives; the feed keeps funding z at null.
      return [];
    },
  };
}

export function createCoinbaseMarket(apiBase: string, timeoutMs: number, concurrency: number, allowNonCrypto: boolean): PublicApi {
  return createCoinbasePublic(createCoinbaseRest({ apiBase, timeoutMs, concurrency }), { allowNonCrypto });
}
