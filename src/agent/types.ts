import type { Config } from "../config.js";
import type { CoinStats, MarketView } from "../market/types.js";

export type Side = "long" | "short";

/** Which lens of the strategy opened the position; it decides the stop and trailing logic that manages it. */
export type Lens = "breakout" | "trend" | "momentum";

export interface Position {
  instId: string;
  coin: string;
  side: Side;
  lens: Lens;
  contracts: number;
  entryPx: number;
  openedAt: number;
  /** Hard stop price, set by code at entry and trailed by the engine. */
  stopPx: number | null;
  /** USD at risk as sized: contracts x ctVal x |average entry - initial stop|. 1R. Re-sized on every add. */
  riskUsd: number;
  /** The stop set at entry, before any trailing. R is measured against it so a trailing stop can't shrink R. */
  initialStopPx: number | null;
  /** Best price seen since entry in the position's favour (profit lock). */
  peakPx: number | null;
  /** Fees paid on this position so far (entry, adds, trims). */
  feesUsd: number;
  /** Realised P&L banked by trims so far (before fees). */
  realisedUsd: number;
  /** Contracts ever bought into this position (for the trade record's size). */
  maxContracts: number;
  /** trend lens: ensemble score at entry, for TRIM. */
  entryScore?: number;
}

export type CapReason = "loss_stop" | "retired" | "trade_cap" | "fee_budget";

export interface AgentState {
  id: "agent";
  /** Realised cash: start equity + realised P&L - fees + funding (ledger). */
  cashUsd: number;
  /** Mark-to-market equity = cash + unrealised P&L of every position. */
  equityUsd: number;
  uplUsd: number;
  /** High-water mark of equity, for drawdown. */
  peakEquityUsd: number;
  dayKey: string;
  dayStartEquityUsd: number;
  positions: Record<string, Position>;
  /** When the agent last became flat (ms), or null while positioned. */
  flatSince: number | null;
  tradesToday: number;
  feesTodayUsd: number;
  lastOrderAt: number | null;
  cap: CapReason | null;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  /** Closed round trips, for the edge estimate that scales position size. */
  record: { wins: number; losses: number; grossWinUsd: number; grossLossUsd: number };
  /** momentum lens: who was #1 on the previous hourly rank, and for how many ranks in a row. */
  top1: { coin: string | null; streak: number; rankedAt: number };
}

/** What a menu option means, in code. The risk layer turns this into a final action. */
export type Intent =
  | { kind: "hold" }
  | { kind: "open"; instId: string; side: Side; lens: Lens; sizeFrac: number; setup: "strict" | "loose" }
  | { kind: "close"; instId: string; reason: string }
  | { kind: "flip"; instId: string; side: Side; lens: Lens; sizeFrac: number }
  | { kind: "add"; instId: string; sizeFrac: number }
  | { kind: "trim"; instId: string; fraction: number };

/** What the risk layer lets through to execution. Sizes are resolved to USD notional. */
export type Action =
  | { kind: "none" }
  | { kind: "open"; instId: string; side: Side; lens: Lens; notionalUsd: number }
  | { kind: "close"; instId: string; reason: string }
  | { kind: "flip"; instId: string; side: Side; lens: Lens; notionalUsd: number }
  | { kind: "add"; instId: string; notionalUsd: number }
  | { kind: "trim"; instId: string; fraction: number };

export interface MenuOption {
  /** null when the label says it all (saves Jev tokens). */
  desc: string | null;
  intent: Intent;
}
export type Menu = Record<string, MenuOption>;

export interface AgentContext {
  agent: AgentState;
  view: MarketView;
  cfg: Config;
  now: number;
}

export interface Brain {
  /** Sent to Jev as the question instructions. */
  strategy: string;
  convictionLabels: readonly [string, string, string, string];
  menu(ctx: AgentContext): Menu;
  /** Coins shown in the snapshot (instIds). */
  snapshotCoins(ctx: AgentContext): string[];
  coinSnapshot(s: CoinStats, ctx: AgentContext): Record<string, number | string | null>;
  /** Stop price for a new position (code decides, not Jev). */
  stopFor(instId: string, side: Side, lens: Lens, entryPx: number, ctx: AgentContext): number | null;
  /** Trailing stop candidate; the engine only ever ratchets the stop in the position's favour. */
  trail(p: Position, ctx: AgentContext): number | null;
  /** Close a position older than this many minutes (lens-specific). */
  timeStopMinutes(p: Position): number;
  /** Profit lock rungs (see profitLockStop). */
  profitLock: ReadonlyArray<{ atPct: number; keep: number }>;
  /** Status line when the menu is empty. */
  idleStatus(ctx: AgentContext): string;
}

export const coinOf = (instId: string) => instId.split("-")[0]!;
export const positionList = (a: AgentState): Position[] => Object.values(a.positions);
