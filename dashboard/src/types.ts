// Mirrors the engine's read-only API: /profile, /snapshot, /analytics, /trades, /equity, /events.

export interface Profile {
  mode: "dry" | "live";
  venue: string;
  links?: { code?: string };
  maxLeverage: number;
  maxTotalNotionalUsd: number;
  maxPositions: number;
  startEquityUsd: number;
  jevModel: string;
}

export let PROFILE: Profile = { mode: "dry", venue: "Coinbase Derivatives", maxLeverage: 3, maxTotalNotionalUsd: 10_000, maxPositions: 0, startEquityUsd: 1000, jevModel: "" };
export function applyProfile(p: Profile): void {
  PROFILE = { ...PROFILE, ...p };
}

export type Side = "long" | "short";
export type Lens = "breakout" | "trend" | "momentum";

export interface PublicPosition {
  instId: string;
  coin: string;
  side: Side;
  lens: Lens;
  contracts: number;
  entryPx: number;
  sizeUsd: number | null;
  markPx: number | null;
  stopPx: number | null;
  uplUsd: number | null;
  uplR: number | null;
  feesUsd: number | null;
  minutesHeld: number;
}

export interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  required?: boolean;
}

export interface PublicAgent {
  equityUsd: number;
  cashUsd: number;
  uplUsd: number;
  pnlUsd: number;
  pnlPct: number;
  dayPnlUsd: number;
  peakEquityUsd: number;
  drawdownPct: number;
  positions: PublicPosition[];
  grossNotionalUsd: number;
  maxNotionalUsd: number;
  flatMinutes: number | null;
  tradesToday: number;
  maxTradesPerDay: number;
  feesTodayUsd: number;
  feeBudgetUsd: number;
  cap: string | null;
  totals: { feesUsd: number; fundingUsd: number; jevUsd: number; realisedUsd: number; decisions: number; orders: number };
  record: { wins: number; losses: number; grossWinUsd: number; grossLossUsd: number };
  last: LastDecision | null;
}

export interface Snapshot {
  ts: number;
  mode: "dry" | "live";
  venue: "sim" | "coinbase";
  startedAt: number;
  closed: { at: number; flat: boolean } | null;
  startEquityUsd: number;
  maxLeverage: number;
  tickMs: number;
  agent: PublicAgent;
  jev: { spentTodayUsd: number; dailyCapUsd: number; capTripped: boolean; down: boolean };
  recon: { ok: boolean | null; detail: string; ts: number };
  market: { refreshedAt: number; universe: string[]; spreadBlocked: Array<{ coin: string; spreadBp: number }>; attention: string };
  watching: number;
  update: { current: string; latest: string } | null;
}

export interface Breakdown {
  key: string;
  trades: number;
  pnlUsd: number;
  winRate: number | null;
}

export interface Analytics {
  sinceTs: number;
  ts: number;
  equity: { start: number | null; end: number | null; pnlUsd: number | null; pnlPct: number | null; peak: number | null; maxDrawdownPct: number | null; maxDrawdownUsd: number | null };
  daily: Array<{ day: string; equityUsd: number; pnlUsd: number }>;
  trades: {
    count: number;
    wins: number;
    losses: number;
    winRate: number | null;
    profitFactor: number | null;
    avgWinUsd: number | null;
    avgLossUsd: number | null;
    expectancyUsd: number | null;
    avgHoldMinutes: number | null;
    bestUsd: number | null;
    worstUsd: number | null;
  };
  byCoin: Breakdown[];
  bySide: Breakdown[];
  byLens: Breakdown[];
  byReason: Breakdown[];
  costs: { feesUsd: number; fundingUsd: number; jevUsd: number; totalUsd: number };
  jev: { decisions: number; asked: number; errors: number; avgLatencyMs: number | null; inputTokens: number; choices: Array<{ label: string; n: number }>; vetoes: Array<{ reason: string; n: number }>; forced: Array<{ reason: string; n: number }> };
  sharpe: number | null;
}

export interface Trade {
  id: number;
  openedTs: number;
  closedTs: number;
  instId: string;
  coin: string;
  side: Side;
  lens: Lens;
  contracts: number;
  entryPx: number;
  exitPx: number;
  notionalUsd: number;
  pnlUsd: number;
  feeUsd: number;
  reason: string;
}

export interface BaseEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

export interface DecisionEvent extends BaseEvent {
  type: "decision";
  choice: string | null;
  watch?: string;
  probabilities: Array<{ label: string; p: number }>;
  required?: boolean;
  pulse?: boolean;
  confidence: number | null;
  conviction: string | null;
  latencyMs: number | null;
  tokens: number | null;
  jevUsd: number;
  action: string;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
  jev: string;
  live?: { positions: number; valueUsd: number; kind: "open" | "total"; deltaUsd: number };
}

export interface FillEvent extends BaseEvent {
  type: "fill";
  coin: string;
  side: "buy" | "sell";
  purpose: string;
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
  label: string;
}

export interface TradeEvent extends BaseEvent {
  type: "trade";
  coin: string;
  side: Side;
  lens: Lens;
  pnlUsd: number;
  reason: string;
  minutesHeld: number;
}

export interface EquityEvent extends BaseEvent, PublicAgent {
  type: "equity";
}

export interface CapEvent extends BaseEvent {
  type: "cap";
  cap: string | null;
  detail: string;
}

export interface FundingEvent extends BaseEvent {
  type: "funding";
  coin: string | null;
  amountUsd: number;
}

export type AnyEvent = DecisionEvent | FillEvent | TradeEvent | EquityEvent | CapEvent | FundingEvent | BaseEvent;
