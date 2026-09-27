// Our own books. In live mode the exchange is the source of truth; reconciliation compares the two.
import { uplUsd } from "./agent/common.js";
import { positionList, type AgentState, type Lens, type Position } from "./agent/types.js";

export function freshAgent(equityUsd: number, now: number): AgentState {
  return {
    id: "agent",
    cashUsd: equityUsd,
    equityUsd,
    uplUsd: 0,
    peakEquityUsd: equityUsd,
    dayKey: dayKey(now),
    dayStartEquityUsd: equityUsd,
    positions: {},
    flatSince: now,
    tradesToday: 0,
    feesTodayUsd: 0,
    lastOrderAt: null,
    cap: null,
    totals: { feesUsd: 0, fundingUsd: 0, jevUsd: 0, realisedUsd: 0, decisions: 0, orders: 0 },
    record: { wins: 0, losses: 0, grossWinUsd: 0, grossLossUsd: 0 },
  };
}

export const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface LedgerFill {
  instId: string;
  coin: string;
  side: "buy" | "sell";
  contracts: number;
  px: number;
  feeUsd: number;
  ctVal: number;
  ts: number;
  /** Lens for a position this fill opens (ignored on reduces). */
  lens: Lens;
}

/** A finished round trip, for the trade log. `pnlUsd` is net of fees. */
export interface ClosedTrade {
  position: Position;
  exitPx: number;
  closedTs: number;
  pnlUsd: number;
  feeUsd: number;
  notionalUsd: number;
}

export interface FillOutcome {
  /** Realised P&L of this fill, before fees. */
  realisedUsd: number;
  /** Set when this fill closed the position for good. */
  closed: ClosedTrade | null;
}

/** Apply a fill to the books. */
export function applyFill(a: AgentState, f: LedgerFill): FillOutcome {
  const dir = f.side === "buy" ? 1 : -1;
  const p = a.positions[f.instId];
  a.cashUsd -= f.feeUsd;
  a.feesTodayUsd += f.feeUsd;
  a.totals.feesUsd += f.feeUsd;
  a.lastOrderAt = f.ts;
  a.totals.orders++;

  if (!p) {
    a.positions[f.instId] = newPosition(f, dir);
    a.flatSince = null;
    return { realisedUsd: 0, closed: null };
  }
  p.feesUsd += f.feeUsd;
  const pDir = p.side === "long" ? 1 : -1;
  if (dir === pDir) {
    const total = p.contracts + f.contracts;
    p.entryPx = (p.entryPx * p.contracts + f.px * f.contracts) / total;
    p.contracts = total;
    p.maxContracts = Math.max(p.maxContracts, total);
    const initStop = p.initialStopPx ?? p.stopPx;
    if (initStop !== null) p.riskUsd = sizedRiskUsd(total, f.ctVal, p.entryPx, initStop);
    return { realisedUsd: 0, closed: null };
  }
  // reduce / close
  const closed = Math.min(p.contracts, f.contracts);
  const realised = pDir * (f.px - p.entryPx) * closed * f.ctVal;
  a.cashUsd += realised;
  a.totals.realisedUsd += realised;
  p.realisedUsd += realised;
  p.riskUsd = p.contracts > 0 ? p.riskUsd * ((p.contracts - closed) / p.contracts) : 0;
  p.contracts = Number((p.contracts - closed).toFixed(8));
  let done: ClosedTrade | null = null;
  if (p.contracts <= 0) {
    delete a.positions[f.instId];
    const pnlUsd = p.realisedUsd - p.feesUsd;
    recordRoundTrip(a, pnlUsd);
    done = { position: p, exitPx: f.px, closedTs: f.ts, pnlUsd, feeUsd: p.feesUsd, notionalUsd: p.maxContracts * f.ctVal * p.entryPx };
    const rest = f.contracts - closed;
    if (rest > 1e-9) a.positions[f.instId] = newPosition({ ...f, contracts: rest }, dir);
    if (positionList(a).length === 0) a.flatSince = f.ts;
  }
  return { realisedUsd: realised, closed: done };
}

/** A closed round trip's net result feeds the edge estimate (only full closes count; trims are part of the trip). */
function recordRoundTrip(a: AgentState, netUsd: number): void {
  if (netUsd >= 0) {
    a.record.wins++;
    a.record.grossWinUsd += netUsd;
  } else {
    a.record.losses++;
    a.record.grossLossUsd += -netUsd;
  }
}

/** USD lost if the whole position exits at `stopPx` from its average entry. */
export function sizedRiskUsd(contracts: number, ctVal: number, entryPx: number, stopPx: number): number {
  return Math.abs(contracts * ctVal * (entryPx - stopPx));
}

function newPosition(f: LedgerFill, dir: number): Position {
  return {
    instId: f.instId,
    coin: f.coin,
    side: dir > 0 ? "long" : "short",
    lens: f.lens,
    contracts: f.contracts,
    entryPx: f.px,
    openedAt: f.ts,
    stopPx: null,
    riskUsd: 0,
    initialStopPx: null,
    peakPx: null,
    feesUsd: f.feeUsd,
    realisedUsd: 0,
    maxContracts: f.contracts,
  };
}

export function applyFunding(a: AgentState, amountUsd: number): void {
  a.cashUsd += amountUsd;
  a.totals.fundingUsd += amountUsd;
}

/** Mark every position to market. Positions without a mark keep their last unrealised value. */
export function markAll(a: AgentState, marks: (instId: string) => { px: number; ctVal: number } | null, lastUpl: Map<string, number>): void {
  let upl = 0;
  for (const p of positionList(a)) {
    const m = marks(p.instId);
    const u = m ? uplUsd(p, m.px, m.ctVal) : (lastUpl.get(p.instId) ?? 0);
    lastUpl.set(p.instId, u);
    upl += u;
  }
  for (const id of [...lastUpl.keys()]) if (!a.positions[id]) lastUpl.delete(id);
  a.uplUsd = upl;
  a.equityUsd = a.cashUsd + upl;
  if (a.equityUsd > a.peakEquityUsd) a.peakEquityUsd = a.equityUsd;
}

/** 00:00 UTC: reset daily counters and every cap except "retired". */
export function rollDay(a: AgentState, now: number): boolean {
  const d = dayKey(now);
  if (d === a.dayKey) return false;
  a.dayKey = d;
  a.dayStartEquityUsd = a.equityUsd;
  a.tradesToday = 0;
  a.feesTodayUsd = 0;
  if (a.cap !== "retired") a.cap = null;
  return true;
}
