// The deterministic risk layer: Jev chooses, code decides. Pure: no I/O, no clock, no randomness.
// Every veto, shrink and force says why. Returns forced closes for every position whose stop fired, plus at most
// one discretionary action from Jev.
import { edgeMultiplier, grossNotionalUsd, maxPositionNotionalUsd, maxTotalNotionalUsd, minutesSince, positionNotional, uplR } from "./agent/common.js";
import { positionList, type Action, type AgentContext, type Brain, type CapReason, type Intent } from "./agent/types.js";

export type { Action } from "./agent/types.js";

export interface Proposal {
  label: string;
  intent: Intent;
  /** Jev's probability for the chosen label. */
  prob: number;
  /** Conviction level, rounded to 0..3. */
  conviction: number;
}

/** "no_options": the menu was empty, so Jev was not asked. */
export type JevStatus = "ok" | "unreachable" | "daily_cap" | "no_options";

export interface RiskInput {
  ctx: AgentContext;
  brain: Brain;
  proposal: Proposal | null;
  jev: JevStatus;
  /** 1, or LIVE_SIZE_MULTIPLIER during the live ramp. */
  sizeMult: number;
  dataAgeMs: number;
  maxDataAgeMs: number;
}

export interface RiskResult {
  /** Forced closes first (stops, caps), then Jev's action if any. */
  actions: Action[];
  vetoedBy: string | null;
  forcedBy: string | null;
  cap: CapReason | null;
  capTripped: CapReason | null;
  status: string;
}

const NONE: Action = { kind: "none" };
const isOpening = (i: Intent) => i.kind === "open" || i.kind === "flip" || i.kind === "add";

export function evaluateCaps(ctx: AgentContext): { cap: CapReason | null; tripped: CapReason | null } {
  const { agent, cfg } = ctx;
  let cap = agent.cap;
  const set = (c: CapReason) => {
    const tripped = cap === c ? null : c;
    cap = c;
    return tripped;
  };
  if (cap === "retired") return { cap, tripped: null };
  if (agent.equityUsd <= cfg.risk.startEquityUsd * (cfg.risk.retireAtPct / 100)) return { cap: "retired", tripped: set("retired") };
  if (cap === "loss_stop") return { cap, tripped: null };
  if (agent.equityUsd <= agent.dayStartEquityUsd * (1 - cfg.risk.dailyLossStopPct / 100)) return { cap: "loss_stop", tripped: set("loss_stop") };
  if (cap) return { cap, tripped: null };
  if (agent.tradesToday >= cfg.risk.maxTradesPerDay) return { cap: "trade_cap", tripped: set("trade_cap") };
  if (agent.feesTodayUsd >= cfg.risk.feeBudgetUsdDay) return { cap: "fee_budget", tripped: set("fee_budget") };
  return { cap: null, tripped: null };
}

export function capStatus(cap: CapReason, ctx: AgentContext): string {
  const n = positionList(ctx.agent).length;
  const riding = n ? `riding ${n} position${n === 1 ? "" : "s"} until stops or 00:00 UTC` : "back at 00:00 UTC";
  switch (cap) {
    case "retired":
      return "retired: equity below the retire line, flat for good";
    case "loss_stop":
      return "daily loss stop hit: flat until 00:00 UTC";
    case "trade_cap":
      return `trade cap: all ${ctx.cfg.risk.maxTradesPerDay} trades used today, ${riding}`;
    case "fee_budget":
      return `fee budget gone ($${ctx.agent.feesTodayUsd.toFixed(2)} of $${ctx.cfg.risk.feeBudgetUsdDay.toFixed(2)}), ${riding}`;
  }
}

interface OpenCheck {
  ok: boolean;
  why?: string;
  notionalUsd?: number;
}

/** Spread gate, per-position cap, total-book cap, edge multiplier, min size. */
function checkOpen(intent: Intent, input: RiskInput): OpenCheck {
  const { ctx, sizeMult } = input;
  const { agent, view, cfg } = ctx;
  const maxTotal = maxTotalNotionalUsd(ctx) * sizeMult;
  const maxPos = maxPositionNotionalUsd(ctx) * sizeMult;
  if (!(maxTotal > 0)) return { ok: false, why: "no_equity" };
  if (intent.kind !== "open" && intent.kind !== "flip" && intent.kind !== "add") return { ok: false, why: "not_opening" };

  const s = view.stats.get(intent.instId);
  const inst = view.instruments.get(intent.instId);
  if (!s || !inst) return { ok: false, why: "no_market_data" };
  if (s.spreadBp > cfg.risk.spreadGateBps) return { ok: false, why: `spread_gate ${s.coin} ${s.spreadBp.toFixed(1)}bp` };
  const minUsd = inst.minSz * inst.ctVal * s.mid;

  // Book room: gross notional of everything else that stays open.
  const gross = grossNotionalUsd(ctx);
  const p = agent.positions[intent.instId];
  const mine = p ? positionNotional(p, s.mid, inst.ctVal) : 0;

  if (intent.kind === "add") {
    if (!p) return { ok: false, why: "invalid_add_flat" };
    const room = Math.min(maxPos - mine, maxTotal - gross);
    const n = Math.min(intent.sizeFrac * maxPos, room);
    if (n < minUsd) return { ok: false, why: "size_cap" };
    return { ok: true, notionalUsd: n };
  }
  if (intent.kind === "open" && p) return { ok: false, why: "already_positioned" };
  if (intent.kind === "flip" && (!p || p.side === intent.side)) return { ok: false, why: "invalid_flip" };
  if (intent.kind === "open" && cfg.risk.maxPositions > 0 && positionList(agent).length >= cfg.risk.maxPositions) return { ok: false, why: "max_positions" };
  if (intent.side === "long" && s.fundingZ !== null && s.fundingZ > 1.5) return { ok: false, why: `funding_veto ${s.coin} z=${s.fundingZ.toFixed(1)}` };

  const edge = cfg.risk.edgeSizing ? edgeMultiplier(agent) : 1;
  const frac = Math.max(0, Math.min(1, intent.sizeFrac * edge));
  // A flip closes `mine` first, so its room is the book without this position.
  const room = maxTotal - (gross - mine);
  const n = Math.min(frac * maxPos, maxPos, room);
  if (n < minUsd) return { ok: false, why: `below_min_size ${s.coin} $${Math.max(0, n).toFixed(2)} < $${minUsd.toFixed(2)}` };
  return { ok: true, notionalUsd: n };
}

function toAction(intent: Intent, notionalUsd?: number): Action {
  switch (intent.kind) {
    case "hold":
      return NONE;
    case "close":
      return { kind: "close", instId: intent.instId, reason: intent.reason };
    case "trim":
      return { kind: "trim", instId: intent.instId, fraction: intent.fraction };
    case "add":
      return { kind: "add", instId: intent.instId, notionalUsd: notionalUsd! };
    case "open":
      return { kind: "open", instId: intent.instId, side: intent.side, lens: intent.lens, notionalUsd: notionalUsd! };
    case "flip":
      return { kind: "flip", instId: intent.instId, side: intent.side, lens: intent.lens, notionalUsd: notionalUsd! };
  }
}

export function applyRisk(input: RiskInput): RiskResult {
  const { ctx, brain, proposal, jev } = input;
  const { agent, view, cfg, now } = ctx;
  const positions = positionList(agent);
  const { cap, tripped } = evaluateCaps(ctx);
  const out = (actions: Action[], extra: Partial<RiskResult> & { status: string }): RiskResult => ({
    actions,
    vetoedBy: null,
    forcedBy: null,
    cap,
    capTripped: tripped,
    ...extra,
  });

  // 1. Retired / daily loss stop: go flat and stay flat.
  if (cap === "retired" || cap === "loss_stop") {
    const status = capStatus(cap, ctx);
    const closes: Action[] = positions.map((p) => ({ kind: "close", instId: p.instId, reason: cap }));
    return out(closes, { forcedBy: closes.length ? cap : null, vetoedBy: proposal ? cap : null, status });
  }

  // 2. Code stops fire whatever Jev says, and even when Jev is down.
  const forced: Action[] = [];
  const stopped: string[] = [];
  for (const p of positions) {
    const s = view.stats.get(p.instId);
    if (s && p.stopPx !== null && (p.side === "long" ? s.mid <= p.stopPx : s.mid >= p.stopPx)) {
      forced.push({ kind: "close", instId: p.instId, reason: "stop" });
      stopped.push(p.coin);
      continue;
    }
    if (minutesSince(p.openedAt, now) >= brain.timeStopMinutes(p)) {
      forced.push({ kind: "close", instId: p.instId, reason: "time_stop" });
      stopped.push(p.coin);
    }
  }
  const closing = new Set(forced.map((a) => (a.kind === "close" ? a.instId : "")));
  const forcedBy = forced.length ? (forced.some((a) => a.kind === "close" && a.reason === "stop") ? "stop" : "time_stop") : null;

  // 3. Jev fail-closed: hold whatever we have, open nothing.
  if (jev === "daily_cap") return out(forced, { forcedBy, vetoedBy: "jev_daily_cap", status: "Jev daily cap hit: holding" });
  if (jev === "unreachable" || (jev === "ok" && !proposal)) return out(forced, { forcedBy, vetoedBy: "jev_unreachable", status: "Jev unreachable: holding" });

  let intent: Intent = proposal?.intent ?? { kind: "hold" };
  let vetoedBy: string | null = null;
  let notionalUsd: number | undefined;
  const veto = (why: string) => {
    vetoedBy = why;
    intent = { kind: "hold" };
  };

  // 4. Menu sanity against the book we actually have.
  if (intent.kind !== "hold" && intent.kind !== "open" && !agent.positions[intent.instId]) veto("invalid_while_flat");
  if (intent.kind !== "hold" && closing.has(intent.instId)) veto("already_closing");
  if (intent.kind === "open" && agent.positions[intent.instId]) veto("already_positioned");

  // 5. Opening gates.
  if (proposal && isOpening(intent)) {
    const dataStale = input.dataAgeMs > input.maxDataAgeMs;
    const cooldownLeft = agent.lastOrderAt === null ? 0 : cfg.risk.cooldownMinutes - minutesSince(agent.lastOrderAt, now);
    if (cap === "trade_cap" || cap === "fee_budget") veto(cap);
    else if (dataStale) veto("stale_market_data");
    else if (intent.kind !== "add" && (proposal.prob < cfg.risk.minOpenProb || proposal.conviction < cfg.risk.minConviction)) veto(`weak_conviction p=${proposal.prob.toFixed(2)} c=${proposal.conviction}`);
    else if (intent.kind === "open" && intent.setup === "loose") veto("no_setup_yet");
    else if (intent.kind === "add") {
      const p = agent.positions[intent.instId];
      const r = p ? uplR(p, ctx) : null;
      if (r === null || r <= 0) veto("add_only_to_winners");
      else {
        const c = checkOpen(intent, input);
        if (c.ok) notionalUsd = c.notionalUsd;
        else veto(c.why!);
      }
    } else if (cooldownLeft > 0) veto(`cooldown ${Math.ceil(cooldownLeft)}m`);
    else {
      const c = checkOpen(intent, input);
      if (c.ok) notionalUsd = c.notionalUsd;
      else veto(c.why!);
    }
  }

  const action = toAction(intent, notionalUsd);
  let status = !proposal ? brain.idleStatus(ctx) : vetoedBy ? `wanted ${proposal.label}, code said no: ${vetoedBy}` : proposal.label;
  if (stopped.length) status = `${forcedBy === "stop" ? "stopped out of" : "time stop on"} ${stopped.join(", ")}; ${status}`;
  if (action.kind === "none" && cap) status = capStatus(cap, ctx);
  else if (action.kind === "none" && !positions.length && input.dataAgeMs > input.maxDataAgeMs) status = "stale market data: waiting";

  const actions = action.kind === "none" ? forced : [...forced, action];
  return { actions, vetoedBy, forcedBy, cap, capTripped: tripped, status };
}
