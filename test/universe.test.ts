// Universe gating: every classified asset kind is tradable by default; unknown/test/near-expiry never are.
import { describe, expect, it } from "vitest";
import { EXPIRY_BUFFER_MS, gateUniverse } from "../src/market/universe.js";
import type { Instrument, Ticker } from "../src/market/types.js";
import { NOW, testConfig } from "./fixtures.js";

const DAY = 86_400_000;
const inst = (instId: string, coin: string, kind: Instrument["kind"], over: Partial<Instrument> = {}): Instrument => ({ instId, coin, kind, ctVal: 1, lotSz: 1, minSz: 1, tickSz: 0.01, state: "live", perpetual: true, expiry: null, ...over });
const tick = (instId: string, vol = 5e6, spreadBp = 2): Ticker => ({ instId, last: 100, bid: 99.99, ask: 100.01, mid: 100, spreadBp, vol24hUsd: vol, open24h: 100, ts: NOW });
const dated = (instId: string, coin: string, kind: Instrument["kind"], daysOut: number) => inst(instId, coin, kind, { perpetual: false, expiry: NOW + daysOut * DAY });

const all = [
  inst("BTC-PERP-INTX", "BTC", "crypto"),
  dated("GCE-26DEC25-CDE", "XAU", "commodity", 60),
  dated("SIL-26DEC25-CDE", "XAG", "commodity", 2),
  dated("MG7-26DEC25-CDE", "MAG7", "stock", 40),
  dated("ZZZ-26DEC25-CDE", "ZZZ", "unknown", 40),
  inst("TEST-PERP-INTX", "TEST", "test"),
];
const tickers = new Map(all.map((i) => [i.instId, tick(i.instId)]));
const gates = (allowNonCrypto: boolean) => ({ min24hVolUsd: 1e6, spreadGateBps: 10, allowNonCrypto });

describe("all-assets universe", () => {
  it("ALLOW_NON_CRYPTO defaults on", () => {
    expect(testConfig().universe.allowNonCrypto).toBe(true);
    expect(testConfig({ ALLOW_NON_CRYPTO: "false" }).universe.allowNonCrypto).toBe(false);
  });

  it("trades crypto perps plus dated metal / index futures, skipping unknown, TEST and contracts inside the expiry buffer", () => {
    const r = gateUniverse(all, tickers, gates(true), NOW);
    expect(r.tradable.sort()).toEqual(["BTC-PERP-INTX", "GCE-26DEC25-CDE", "MG7-26DEC25-CDE"]);
    expect(r.unknown).toEqual(["ZZZ-26DEC25-CDE"]);
  });

  it("the expiry buffer is exactly three days", () => {
    const edge = [dated("A-CDE", "XAU", "commodity", 3.01), dated("B-CDE", "XAU", "commodity", 2.99)];
    const t = new Map(edge.map((i) => [i.instId, tick(i.instId)]));
    expect(gateUniverse(edge, t, gates(true), NOW).tradable).toEqual(["A-CDE"]);
    expect(EXPIRY_BUFFER_MS).toBe(3 * DAY);
  });

  it("crypto-only mode still works", () => {
    expect(gateUniverse(all, tickers, gates(false), NOW).tradable).toEqual(["BTC-PERP-INTX"]);
  });

  it("volume and spread gates apply to every kind", () => {
    const t = new Map(tickers);
    t.set("GCE-26DEC25-CDE", tick("GCE-26DEC25-CDE", 5e5));
    t.set("MG7-26DEC25-CDE", tick("MG7-26DEC25-CDE", 5e6, 25));
    const r = gateUniverse(all, t, gates(true), NOW);
    expect(r.tradable).toEqual(["BTC-PERP-INTX"]);
    expect(r.spreadBlocked).toEqual(["MG7-26DEC25-CDE"]);
  });
});
