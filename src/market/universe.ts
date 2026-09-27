import type { Instrument, Ticker } from "./types.js";

export interface UniverseResult {
  /** Passed every gate, ranked by 24h USD volume. */
  tradable: string[];
  /** Passed volume but failed the spread gate. */
  spreadBlocked: string[];
  /** Live instruments we could not classify (never traded). */
  unknown: string[];
}

export interface GateOpts {
  min24hVolUsd: number;
  spreadGateBps: number;
  allowNonCrypto: boolean;
}

/** Dated contracts within this many days of expiry are never opened. */
export const EXPIRY_BUFFER_MS = 3 * 86_400_000;

/**
 * Discover, never hard-code. Live, perpetual (dated contracts only with ALLOW_NON_CRYPTO and >3 days to expiry),
 * not TEST*, crypto unless allowed, volume and spread gates.
 */
export function gateUniverse(instruments: Iterable<Instrument>, tickers: Map<string, Ticker>, g: GateOpts, now = Date.now()): UniverseResult {
  const tradable: Array<[string, number]> = [];
  const spreadBlocked: string[] = [];
  const unknown: string[] = [];
  for (const i of instruments) {
    if (i.state !== "live" || i.coin.startsWith("TEST")) continue;
    if (!i.perpetual && (!g.allowNonCrypto || i.expiry === null || i.expiry - now < EXPIRY_BUFFER_MS)) continue;
    if (i.kind === "unknown") {
      unknown.push(i.instId);
      continue;
    }
    if (i.kind === "test") continue;
    if (i.kind !== "crypto" && !g.allowNonCrypto) continue;
    const t = tickers.get(i.instId);
    if (!t || !(t.vol24hUsd >= g.min24hVolUsd)) continue;
    if (!(t.spreadBp <= g.spreadGateBps)) {
      spreadBlocked.push(i.instId);
      continue;
    }
    tradable.push([i.instId, t.vol24hUsd]);
  }
  tradable.sort((a, b) => b[1] - a[1]);
  return { tradable: tradable.map(([id]) => id), spreadBlocked, unknown };
}
