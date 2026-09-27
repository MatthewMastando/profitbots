// Coinbase adapter: JWT auth, REST plumbing, product/ticker/candle parsing and the live executor, all on fixtures.
import { createVerify, generateKeyPairSync, verify as edVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildJwt, decodeJwt, loadKey } from "../src/coinbase/auth.js";
import { createCoinbasePublic, isPerpetual, parseCandles, isTradable, parseProduct, parseTicker, type CbProduct } from "../src/coinbase/public.js";
import { CoinbaseError, createCoinbaseRest, qs } from "../src/coinbase/rest.js";
import { CoinbaseExecutor } from "../src/exec/executor.js";
import { NOW } from "./fixtures.js";

const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_PEM = ec.privateKey.export({ type: "sec1", format: "pem" }).toString();
const ed = generateKeyPairSync("ed25519");
const ED_B64 = Buffer.concat([
  (ed.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(-32),
  (ed.publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32),
]).toString("base64");
const KEY_NAME = "organizations/org-1/apiKeys/key-1";

describe("coinbase auth", () => {
  it("builds the CDP JWT shape with ES256 and a verifiable signature", () => {
    const t = buildJwt({ keyName: KEY_NAME, privateKey: EC_PEM }, "get", "api.coinbase.com", "/api/v3/brokerage/cfm/positions", NOW);
    const { header, payload } = decodeJwt(t);
    expect(header).toMatchObject({ alg: "ES256", kid: KEY_NAME, typ: "JWT" });
    expect(typeof header.nonce).toBe("string");
    expect(payload).toEqual({ sub: KEY_NAME, iss: "cdp", nbf: Math.floor(NOW / 1000), exp: Math.floor(NOW / 1000) + 120, uri: "GET api.coinbase.com/api/v3/brokerage/cfm/positions" });
    const [h, p, s] = t.split(".");
    const sig = Buffer.from(s!, "base64url");
    expect(sig).toHaveLength(64);
    // raw r||s -> DER so node can verify.
    const v = createVerify("SHA256");
    v.update(`${h}.${p}`);
    expect(v.verify({ key: ec.publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("accepts a 64-byte base64 Ed25519 key and signs with EdDSA", () => {
    expect(loadKey(ED_B64).alg).toBe("EdDSA");
    const t = buildJwt({ keyName: KEY_NAME, privateKey: ED_B64 }, "POST", "api.coinbase.com", "/api/v3/brokerage/orders", NOW);
    const [h, p, s] = t.split(".");
    expect(decodeJwt(t).header.alg).toBe("EdDSA");
    expect(edVerify(null, Buffer.from(`${h}.${p}`), ed.publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });

  it("rejects garbage keys without echoing them", () => {
    expect(() => loadKey("not-a-key-SECRET")).toThrow(/neither a PEM key nor/);
    expect(() => loadKey("-----BEGIN EC PRIVATE KEY-----\nSECRET\n-----END EC PRIVATE KEY-----")).toThrow(/not a valid PEM/);
    try {
      loadKey("-----BEGIN EC PRIVATE KEY-----\nSECRET\n-----END EC PRIVATE KEY-----");
    } catch (e) {
      expect((e as Error).message).not.toContain("SECRET");
    }
  });
});


type Call = { url: string; init: RequestInit };
function fakeFetch(handler: (c: Call) => { status?: number; body?: unknown; delayMs?: number } | Promise<{ status?: number; body?: unknown; delayMs?: number }>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(url), init: init ?? {} };
    calls.push(c);
    const r = await handler(c);
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fn, calls };
}

describe("coinbase rest", () => {
  it("serialises query strings incl. repeated keys, and skips undefined", () => {
    expect(qs({ product_type: "FUTURE", get_all_products: true, x: undefined })).toBe("?product_type=FUTURE&get_all_products=true");
    expect(qs({ product_ids: ["A-1", "B-2"] })).toBe("?product_ids=A-1&product_ids=B-2");
    expect(qs(undefined)).toBe("");
  });

  it("public GETs are unsigned and cached for the ttl; signed calls carry a bearer JWT for the path only", async () => {
    const f = fakeFetch(() => ({ body: { ok: 1 } }));
    const rest = createCoinbaseRest({ apiBase: "https://api.coinbase.com/", timeoutMs: 1000, concurrency: 4, fetchFn: f.fn, key: { keyName: KEY_NAME, privateKey: EC_PEM } });
    await rest.get("/api/v3/brokerage/market/products", { product_type: "FUTURE" }, 5000);
    await rest.get("/api/v3/brokerage/market/products", { product_type: "FUTURE" }, 5000);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.coinbase.com/api/v3/brokerage/market/products?product_type=FUTURE");
    expect((f.calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();

    await rest.signed("GET", "/api/v3/brokerage/orders/historical/fills", undefined, { limit: 5 });
    const h = f.calls[1]!.init.headers as Record<string, string>;
    expect(h.authorization).toMatch(/^Bearer /);
    expect(decodeJwt(h.authorization!.slice(7)).payload.uri).toBe("GET api.coinbase.com/api/v3/brokerage/orders/historical/fills");
    expect(f.calls[1]!.url).toContain("?limit=5");

    await rest.signed("POST", "/api/v3/brokerage/orders", { a: 1 });
    expect(f.calls[2]!.init.method).toBe("POST");
    expect(f.calls[2]!.init.body).toBe('{"a":1}');
  });

  it("a 429 on a GET is retried with backoff; a 429 on a POST is not", async () => {
    let n = 0;
    const f = fakeFetch((c) => (c.init.method === "POST" || ++n < 3 ? { status: 429, body: { error: "RATE_LIMITED" } } : { body: { ok: true } }));
    const rest = createCoinbaseRest({ apiBase: "https://api.coinbase.com", timeoutMs: 1000, concurrency: 1, key: { keyName: "k", privateKey: ec.privateKey.export({ type: "sec1", format: "pem" }).toString() }, fetchFn: f.fn });
    await expect(rest.get("/x")).resolves.toEqual({ ok: true });
    expect(n).toBe(3);
    await expect(rest.signed("POST", "/api/v3/brokerage/orders", { a: 1 })).rejects.toMatchObject({ status: 429 });
    expect(f.calls.filter((c) => c.init.method === "POST")).toHaveLength(1);
  });

  it("errors carry status + Coinbase code; a timeout is a network error; no key means no signed calls", async () => {
    const f = fakeFetch((c) => (c.url.includes("slow") ? { body: {}, delayMs: 200 } : { status: 401, body: { error: "UNAUTHORIZED", message: "bad jwt" } }));
    const rest = createCoinbaseRest({ apiBase: "https://api.coinbase.com", timeoutMs: 20, concurrency: 1, fetchFn: f.fn });
    await expect(rest.get("/x")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED", message: "bad jwt" });
    const slow = fakeFetch(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { body: {} };
    });
    const slowRest = createCoinbaseRest({ apiBase: "https://api.coinbase.com", timeoutMs: 20, concurrency: 1, fetchFn: (u, i) => fetchWithSignal(slow.fn, u, i) });
    await expect(slowRest.get("/slow")).rejects.toBeInstanceOf(CoinbaseError);
    await expect(rest.signed("GET", "/x")).rejects.toMatchObject({ code: "NO_KEY" });
    expect(rest.authenticated).toBe(false);
  });
});

async function fetchWithSignal(fn: typeof fetch, url: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    fn(url, init).then(resolve, reject);
  });
}

const FAR = new Date(NOW + 20 * 365 * 86_400_000).toISOString();
const perp = (id: string, coin: string, over: Partial<CbProduct> = {}): CbProduct => ({
  product_id: id,
  price: "100",
  price_percentage_change_24h: "2",
  volume_24h: "5000",
  approximate_quote_24h_volume: "50000000",
  base_increment: "1",
  quote_increment: "0.01",
  base_min_size: "1",
  status: "online",
  trading_disabled: false,
  product_type: "FUTURE",
  display_name: `${coin} PERP`,
  future_product_details: {
    venue: "INTX",
    contract_code: coin,
    contract_expiry: FAR,
    contract_size: "0.1",
    contract_root_unit: coin,
    contract_expiry_type: "EXPIRING",
    perpetual_details: { open_interest: "1000", funding_rate: "0.0001", funding_time: new Date(NOW + 3_600_000).toISOString() },
  },
  ...over,
});

describe("coinbase products", () => {
  it("perps are detected by perpetual_details or far expiry; dated contracts are not", () => {
    expect(isPerpetual(perp("BTC-PERP-INTX", "BTC"), NOW)).toBe(true);
    const dated = perp("BIT-27MAR26-CDE", "BTC", { future_product_details: { contract_expiry: new Date(NOW + 60 * 86_400_000).toISOString(), contract_size: "0.01", contract_root_unit: "BTC", venue: "CDE" } });
    expect(isPerpetual(dated, NOW)).toBe(false);
    const i = parseProduct(dated);
    expect(i).toMatchObject({ coin: "BTC", perpetual: false, ctVal: 0.01, kind: "crypto" });
    expect(i.expiry).toBe(Date.parse(dated.future_product_details!.contract_expiry!));
  });

  it("maps a perp to an Instrument with contract size, lot, min size and tick", () => {
    expect(parseProduct(perp("SOL-PERP-INTX", "SOL"))).toEqual({ instId: "SOL-PERP-INTX", coin: "SOL", kind: "crypto", ctVal: 0.1, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live", perpetual: true, expiry: null });
  });

  it("real futures rows have an empty status: tradability comes from the flags and the FCM session", () => {
    const real = perp("BIP-20DEC30-CDE", "BTC", { status: "", is_disabled: false, view_only: false, fcm_trading_session_details: { is_session_open: true, session_state: "FCM_TRADING_SESSION_STATE_OPEN" } });
    expect(isTradable(real)).toBe(true);
    expect(parseProduct(real).state).toBe("live");
    expect(isTradable({ ...real, fcm_trading_session_details: { is_session_open: false, session_state: "FCM_TRADING_SESSION_STATE_CLOSED" } })).toBe(false);
    expect(isTradable({ ...real, view_only: true })).toBe(false);
    expect(isTradable({ ...real, trading_disabled: true })).toBe(false);
    expect(parseProduct({ ...real, status: "delisted" }).state).toBe("delisted");
  });

  it("commodity and equity index contracts are tagged non-crypto", () => {
    expect(parseProduct(perp("GLD-27MAR26-CDE", "GLD", { display_name: "Gold futures", future_product_details: { contract_size: "1", contract_root_unit: "GOLD", venue: "CDE" } })).kind).not.toBe("crypto");
    expect(parseProduct(perp("MAG7-PERP-INTX", "MAG7", { display_name: "MAG 7 index" })).kind).not.toBe("crypto");
    const gol = parseProduct(perp("GOL-25NOV26-CDE", "GLD", { display_name: "GLD 25 NOV 26", future_product_details: { contract_size: "1", contract_root_unit: "CDEGLD", group_description: "Gold Futures", contract_expiry: "2026-11-25T00:00:00Z", venue: "CDE" } }));
    expect(gol).toMatchObject({ coin: "GLD", kind: "commodity" });
    const oil = parseProduct(perp("NOL-19OCT26-CDE", "OIL", { display_name: "OIL 19 OCT 26", future_product_details: { contract_size: "1", contract_root_unit: "CDEOIL", group_description: "nano Crude Oil Futures", contract_expiry: "2026-10-19T00:00:00Z", venue: "CDE" } }));
    expect(oil).toMatchObject({ coin: "OIL", kind: "commodity" });
    const us5 = parseProduct(perp("US5-19DEC30-CDE", "US5", { display_name: "US 500 PERP", future_product_details: { contract_size: "1", contract_root_unit: "CDEUS5", group_description: "US500 Index Perp Style Futures", contract_expiry: "2030-12-19T00:00:00Z", venue: "CDE" } }));
    expect(us5).toMatchObject({ coin: "US5", kind: "stock" });
    const mc = parseProduct(perp("MC-17DEC26-CDE", "MAG7C", { display_name: "MAG7C 17 DEC 26", future_product_details: { contract_size: "1", contract_root_unit: "CDEMC", group_description: "Mag7+Crypto Futures", contract_expiry: "2026-12-17T00:00:00Z", venue: "CDE" } }));
    expect(mc).toMatchObject({ coin: "MC", kind: "stock" });
  });

  it("ticker: mid from bid/ask when quoted, spread in bps, quote volume, open from 24h change", () => {
    const t = parseTicker(perp("SOL-PERP-INTX", "SOL", { price: "102" }), { best_bid: "101.9", best_ask: "102.1" }, NOW);
    expect(t).toMatchObject({ instId: "SOL-PERP-INTX", last: 102, bid: 101.9, ask: 102.1, mid: 102, vol24hUsd: 50_000_000, ts: NOW });
    expect(t.spreadBp).toBeCloseTo((0.2 / 102) * 10_000);
    expect(t.open24h).toBeCloseTo(100);
    const unq = parseTicker(perp("X-PERP-INTX", "X"), null, NOW);
    expect(unq.mid).toBe(100);
    expect(unq.spreadBp).toBe(Infinity);
  });

  it("candles sort ascending, convert volume to USD via contract size, and flag the open bar", () => {
    const rows = [
      { start: String(Math.floor(NOW / 1000) - 3600), low: "1", high: "3", open: "2", close: "2.5", volume: "10" },
      { start: String(Math.floor(NOW / 1000) - 7200), low: "1", high: "2", open: "1", close: "2", volume: "4" },
      { start: String(Math.floor(NOW / 1000)), low: "2", high: "3", open: "2.5", close: "3", volume: "1" },
    ];
    const c = parseCandles(rows, 3_600_000, 0.1, NOW + 1000);
    expect(c.map((x) => x.c)).toEqual([2, 2.5, 3]);
    expect(c[0]!.volUsd).toBeCloseTo(4 * 0.1 * 2);
    expect(c.map((x) => x.confirmed)).toEqual([true, true, false]);
  });

  it("PublicApi: instruments/tickers/funding/openInterest over the futures product list; only perps get quoted", async () => {
    const ps = [perp("BTC-PERP-INTX", "BTC"), perp("SOL-PERP-INTX", "SOL", { approximate_quote_24h_volume: "1" }), perp("BIT-27MAR26-CDE", "BTC", { future_product_details: { contract_expiry: new Date(NOW + 60 * 86_400_000).toISOString(), contract_size: "0.01", contract_root_unit: "BTC", venue: "CDE" } })];
    const f = fakeFetch((c) => (c.url.includes("/ticker") ? { body: { best_bid: "99", best_ask: "101" } } : { body: { products: ps } }));
    const api = createCoinbasePublic(createCoinbaseRest({ apiBase: "https://api.coinbase.com", timeoutMs: 1000, concurrency: 4, fetchFn: f.fn }), { allowNonCrypto: false, now: () => NOW });
    expect((await api.instruments()).map((i) => i.instId)).toEqual(["BTC-PERP-INTX", "SOL-PERP-INTX", "BIT-27MAR26-CDE"]);
    const t = await api.tickers();
    expect(t.get("BTC-PERP-INTX")!.mid).toBe(100);
    expect(t.get("BIT-27MAR26-CDE")!.spreadBp).toBe(Infinity);
    expect(f.calls.filter((c) => c.url.includes("/ticker"))).toHaveLength(2);
    expect(f.calls[0]!.url).toContain("product_type=FUTURE&get_all_products=true");
    expect(await api.funding("BTC-PERP-INTX")).toMatchObject({ rate: 0.0001 });
    expect((await api.openInterest()).get("BTC-PERP-INTX")).toBeCloseTo(1000 * 0.1 * 100);
    expect(await api.fundingHistory("BTC-PERP-INTX", 10)).toEqual([]);
  });
});

describe("coinbase executor", () => {
  const inst = () => parseProduct(perp("SOL-PERP-INTX", "SOL"));
  const key = { keyName: KEY_NAME, privateKey: EC_PEM };
  const mk = (handler: Parameters<typeof fakeFetch>[0]) => {
    const f = fakeFetch(handler);
    const rest = createCoinbaseRest({ apiBase: "https://api.coinbase.com", timeoutMs: 1000, concurrency: 4, fetchFn: f.fn, key });
    let t = NOW;
    return { f, ex: new CoinbaseExecutor(rest, () => inst(), { leverage: 5, portfolioId: "pf-1", pollMs: 0, pollTimeoutMs: 5000, now: () => (t += 100) }) };
  };

  it("submits a market IOC in contracts with leverage and polls the order to a fill", async () => {
    let polls = 0;
    const { f, ex } = mk((c) => {
      if (c.url.endsWith("/orders")) return { body: { success: true, success_response: { order_id: "o-1" } } };
      if (c.url.includes("/orders/historical/o-1")) return { body: { order: ++polls < 2 ? { status: "OPEN", filled_size: "0" } : { status: "FILLED", filled_size: "12", average_filled_price: "100.5", total_fees: "0.36", last_fill_time: "2026-09-24T12:00:00Z" } } };
      return { body: {} };
    });
    const r = await ex.market({ instId: "SOL-PERP-INTX", side: "buy", contracts: 12.7, reduceOnly: false, clOrdId: "cl-1" });
    expect(r).toEqual({ ok: true, ordId: "o-1", contracts: 12, avgPx: 100.5, feeUsd: 0.36, ts: Date.parse("2026-09-24T12:00:00Z") });
    const body = JSON.parse(f.calls[0]!.init.body as string);
    expect(body).toEqual({ client_order_id: "cl-1", product_id: "SOL-PERP-INTX", side: "BUY", order_configuration: { market_market_ioc: { base_size: "12" } }, leverage: "5", margin_type: "ISOLATED", retail_portfolio_id: "pf-1" });
    expect(polls).toBe(2);
  });

  it("a Coinbase rejection is 'rejected' with its reason; a 5xx/timeout is 'unknown' so the engine reconciles", async () => {
    const { ex } = mk(() => ({ body: { success: false, error_response: { error: "INSUFFICIENT_FUND", message: "Insufficient balance in source account" } } }));
    expect(await ex.market({ instId: "SOL-PERP-INTX", side: "buy", contracts: 1, reduceOnly: false, clOrdId: "c" })).toMatchObject({ ok: false, state: "rejected", error: { code: "INSUFFICIENT_FUND" } });
    const { ex: ex5 } = mk(() => ({ status: 503, body: { error: "UNAVAILABLE" } }));
    expect(await ex5.market({ instId: "SOL-PERP-INTX", side: "buy", contracts: 1, reduceOnly: false, clOrdId: "c" })).toMatchObject({ ok: false, state: "unknown" });
    const { ex: ex4 } = mk(() => ({ status: 400, body: { error: "INVALID_ARGUMENT" } }));
    expect(await ex4.market({ instId: "SOL-PERP-INTX", side: "buy", contracts: 1, reduceOnly: false, clOrdId: "c" })).toMatchObject({ ok: false, state: "rejected" });
  });

  it("an accepted order that never fills is reported as rejected-no-fill", async () => {
    const { ex } = mk((c) => (c.url.endsWith("/orders") ? { body: { success: true, success_response: { order_id: "o-2" } } } : { body: { order: { status: "CANCELLED", filled_size: "0" } } }));
    expect(await ex.market({ instId: "SOL-PERP-INTX", side: "sell", contracts: 1, reduceOnly: true, clOrdId: "c" })).toMatchObject({ ok: false, state: "rejected", error: { code: "CANCELLED" } });
  });

  it("positions are signed by side; fees are summed per order from fills", async () => {
    const { f, ex } = mk((c) => {
      if (c.url.includes("/cfm/positions")) return { body: { positions: [{ product_id: "SOL-PERP-INTX", side: "SHORT", number_of_contracts: "3", avg_entry_price: "101" }, { product_id: "BTC-PERP-INTX", side: "LONG", number_of_contracts: "0" }] } };
      if (c.url.includes("/fills")) return { body: { fills: [{ order_id: "o-1", commission: "0.1" }, { order_id: "o-1", commission: "0.2" }, { order_id: "zzz", commission: "9" }] } };
      if (c.url.includes("/balance_summary")) return { body: { balance_summary: { futures_buying_power: { value: "500" } } } };
      return { body: {} };
    });
    await ex.init();
    expect(await ex.positions()).toEqual([{ instId: "SOL-PERP-INTX", pos: -3, avgPx: 101 }]);
    const fees = await ex.feesFor(["SOL-PERP-INTX"], new Set(["o-1"]));
    expect(fees!.get("o-1")).toBeCloseTo(0.3);
    expect(f.calls.at(-1)!.url).toContain("order_ids=o-1");
    expect(await ex.fundingBills()).toBeNull();
  });
});
