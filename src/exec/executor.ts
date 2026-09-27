import type { CoinbaseRest } from "../coinbase/rest.js";
import { CoinbaseError } from "../coinbase/rest.js";
import { log } from "../log.js";
import type { Instrument, Ticker } from "../market/types.js";
import { safeError } from "../redact.js";
import { formatSz } from "./sizing.js";

export interface OrderReq {
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  clOrdId: string;
}

export type OrderResult =
  | { ok: true; ordId: string | null; contracts: number; avgPx: number; feeUsd: number; ts: number }
  | { ok: false; error: { code: string; message: string }; state: "rejected" | "unknown" };

export interface ExchangePosition {
  instId: string;
  /** Signed contracts: + long, - short. */
  pos: number;
  avgPx: number;
}

export interface FundingBill {
  billId: string;
  instId: string | null;
  amountUsd: number;
  ts: number;
}

/** One account. The engine talks to the venue only through this. */
export interface Executor {
  readonly kind: "sim" | "coinbase";
  init(): Promise<void>;
  market(req: OrderReq): Promise<OrderResult>;
  /** Open positions on the venue, or null when the venue does not report them (sim). */
  positions(): Promise<ExchangePosition[] | null>;
  /** Funding settlements since the last call, or null when unavailable. */
  fundingBills(): Promise<FundingBill[] | null>;
  /** Fees the venue charged for these order ids (USD, positive = paid), or null when unavailable. */
  feesFor(instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null>;
}

/** MODE=dry: real market data, simulated taker fills at the touch (bid/ask), no private calls. */
export class SimExecutor implements Executor {
  readonly kind = "sim" as const;
  constructor(
    private market_: () => { tickers: Map<string, Ticker>; instruments: Map<string, Instrument> },
    private takerFeeRate: number,
    private now: () => number = Date.now,
  ) {}

  async init(): Promise<void> {}

  async market(req: OrderReq): Promise<OrderResult> {
    const { tickers, instruments } = this.market_();
    const t = tickers.get(req.instId);
    const inst = instruments.get(req.instId);
    if (!t || !inst) return { ok: false, error: { code: "SIM", message: "no ticker" }, state: "rejected" };
    const px = req.side === "buy" ? (t.ask > 0 ? t.ask : t.last) : t.bid > 0 ? t.bid : t.last;
    const feeUsd = req.contracts * inst.ctVal * px * this.takerFeeRate;
    return { ok: true, ordId: null, contracts: req.contracts, avgPx: px, feeUsd, ts: this.now() };
  }

  async positions(): Promise<null> {
    return null;
  }
  async fundingBills(): Promise<null> {
    return null;
  }
  async feesFor(): Promise<null> {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => (v === undefined || v === null || v === "" ? NaN : Number(v));

interface CbOrderResponse {
  success?: boolean;
  success_response?: { order_id?: string; product_id?: string; client_order_id?: string };
  error_response?: { error?: string; message?: string; error_details?: string; preview_failure_reason?: string };
}
interface CbOrder {
  order_id?: string;
  status?: string;
  filled_size?: string;
  average_filled_price?: string;
  total_fees?: string;
  created_time?: string;
  last_fill_time?: string;
}
interface CbFill {
  order_id?: string;
  product_id?: string;
  commission?: string;
}
interface CbPosition {
  product_id?: string;
  side?: string;
  number_of_contracts?: string;
  avg_entry_price?: string;
}

export interface CoinbaseExecOpts {
  /** Configured cap; passed on every order (Coinbase also enforces its own product maximum). */
  leverage: number;
  portfolioId?: string;
  pollMs?: number;
  pollTimeoutMs?: number;
  now?: () => number;
}

/**
 * MODE=live: Coinbase Advanced Trade market IOC orders on Coinbase Derivatives (CFM) products, sized in contracts.
 * Fills, fees and positions come back from Coinbase; reconciliation in the engine compares them to our books.
 */
export class CoinbaseExecutor implements Executor {
  readonly kind = "coinbase" as const;
  private readonly pollMs: number;
  private readonly pollTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    private rest: CoinbaseRest,
    private instrument: (instId: string) => Instrument | undefined,
    private opts: CoinbaseExecOpts,
  ) {
    this.pollMs = opts.pollMs ?? 500;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 15_000;
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    // Proves the key works and the futures account exists before the first tick.
    const s = await this.rest.signed<{ balance_summary?: { futures_buying_power?: { value?: string } } }>("GET", "/api/v3/brokerage/cfm/balance_summary");
    log.info("coinbase futures account ready", { buyingPower: s.balance_summary?.futures_buying_power?.value ?? "?" });
  }

  async market(req: OrderReq): Promise<OrderResult> {
    const inst = this.instrument(req.instId);
    if (!inst) return { ok: false, error: { code: "NO_INSTRUMENT", message: `unknown instrument ${req.instId}` }, state: "rejected" };
    const body = {
      client_order_id: req.clOrdId,
      product_id: req.instId,
      side: req.side.toUpperCase(),
      order_configuration: { market_market_ioc: { base_size: formatSz(req.contracts, inst) } },
      leverage: String(this.opts.leverage),
      margin_type: "ISOLATED",
      ...(this.opts.portfolioId ? { retail_portfolio_id: this.opts.portfolioId } : {}),
    };
    let r: CbOrderResponse;
    try {
      r = await this.rest.signed<CbOrderResponse>("POST", "/api/v3/brokerage/orders", body);
    } catch (err) {
      const e = safeError(err);
      // A timeout after the request may have reached Coinbase: the order might exist. Tell the engine so it reconciles.
      const state = err instanceof CoinbaseError && err.status >= 400 && err.status < 500 ? "rejected" : "unknown";
      return { ok: false, error: e, state };
    }
    if (!r.success || !r.success_response?.order_id) {
      const e = r.error_response ?? {};
      return { ok: false, error: { code: e.error ?? "REJECTED", message: e.preview_failure_reason ?? e.message ?? e.error_details ?? "order rejected" }, state: "rejected" };
    }
    const ordId = r.success_response.order_id;
    const deadline = this.now() + this.pollTimeoutMs;
    let last: CbOrder | null = null;
    while (this.now() < deadline) {
      try {
        const o = await this.rest.signed<{ order?: CbOrder }>("GET", `/api/v3/brokerage/orders/historical/${encodeURIComponent(ordId)}`);
        last = o.order ?? null;
      } catch (err) {
        log.warn("coinbase order poll failed", { err: safeError(err) });
      }
      const st = last?.status ?? "";
      if (st === "FILLED" || st === "CANCELLED" || st === "EXPIRED" || st === "FAILED") break;
      await sleep(this.pollMs);
    }
    const filled = num(last?.filled_size);
    if (!last || !(filled > 0)) {
      const st = last?.status ?? "UNKNOWN";
      return { ok: false, error: { code: st, message: `order ${st.toLowerCase()} with no fill` }, state: last ? "rejected" : "unknown" };
    }
    return {
      ok: true,
      ordId,
      contracts: filled,
      avgPx: num(last.average_filled_price),
      feeUsd: num(last.total_fees) || 0,
      ts: Date.parse(last.last_fill_time ?? last.created_time ?? "") || this.now(),
    };
  }

  async positions(): Promise<ExchangePosition[]> {
    const r = await this.rest.signed<{ positions?: CbPosition[] }>("GET", "/api/v3/brokerage/cfm/positions");
    const out: ExchangePosition[] = [];
    for (const p of r.positions ?? []) {
      const n = num(p.number_of_contracts);
      if (!p.product_id || !(n > 0)) continue;
      const sign = (p.side ?? "").toUpperCase() === "SHORT" ? -1 : 1;
      out.push({ instId: p.product_id, pos: sign * n, avgPx: num(p.avg_entry_price) });
    }
    return out;
  }

  async fundingBills(): Promise<null> {
    // Coinbase Derivatives settles perpetual funding into the futures balance; no per-bill endpoint is documented.
    return null;
  }

  async feesFor(instIds: string[], ordIds: Set<string>): Promise<Map<string, number> | null> {
    if (!ordIds.size) return new Map();
    try {
      const r = await this.rest.signed<{ fills?: CbFill[] }>("GET", "/api/v3/brokerage/orders/historical/fills", undefined, {
        order_ids: [...ordIds].join(","),
        product_ids: instIds.join(","),
        limit: 250,
      });
      const out = new Map<string, number>();
      for (const f of r.fills ?? []) {
        if (!f.order_id || !ordIds.has(f.order_id)) continue;
        out.set(f.order_id, (out.get(f.order_id) ?? 0) + (num(f.commission) || 0));
      }
      return out;
    } catch (err) {
      log.warn("coinbase fills lookup failed", { err: safeError(err) });
      return null;
    }
  }
}
