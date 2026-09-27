import { brain as defaultBrain } from "./agent/brain.js";
import { grossNotionalUsd, maxTotalNotionalUsd, minutesSince, positionNotional, profitLockStop, r2, uplUsd } from "./agent/common.js";
import { coinOf, positionList, type Action, type AgentContext, type AgentState, type Brain, type Lens, type Position, type Side } from "./agent/types.js";
import type { Config } from "./config.js";
import type { Alerts } from "./alerts.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { Executor } from "./exec/executor.js";
import { contractsFor, roundToLot } from "./exec/sizing.js";
import type { Jev, JevAnswer, JevResult } from "./jev.js";
import { applyFill, applyFunding, freshAgent, markAll, rollDay, sizedRiskUsd } from "./ledger.js";
import { log } from "./log.js";
import type { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { applyRisk, type JevStatus, type Proposal } from "./risk.js";
import { buildSnapshot } from "./snapshot.js";

const FUNDING_HOURS_UTC = [0, 8, 16];
const RECON_MS = 5 * 60_000;
/** How often an idle agent gets a live row in the stream. */
const PULSE_MS = 4_000;
/** How long the agent opens nothing after the exchange rejects one of its new orders. */
export const ORDER_REJECT_PAUSE_MS = 10 * 60_000;
const EQUITY_SNAPSHOT_MS = 10_000;

export interface EngineDeps {
  cfg: Config;
  db: Db;
  feed: MarketFeed;
  jev: Jev;
  exec: Executor;
  bus: EventBus;
  alerts: Alerts;
  brain?: Brain;
  now?: () => number;
  /** True once someone asked to stop trading (deploy/close.sh drops a flag file in the data volume). */
  closeRequested?: () => boolean;
  /** Dry run only: consume a one-shot "resume last position" request (flag file). */
  takeResumeRequest?: () => boolean;
}

interface LastDecision {
  choice: string | null;
  top3: Array<[string, number]>;
  confidence: number | null;
  latencyMs: number | null;
  status: string;
  ts: number;
  /** The rules made the call (one legal move, a hold); Jev was not asked. */
  required?: boolean;
}

/** Move a stop only in the position's favour. */
function ratchetStop(p: Position, cand: number): void {
  if (p.stopPx === null) p.stopPx = cand;
  else p.stopPx = p.side === "long" ? Math.max(p.stopPx, cand) : Math.min(p.stopPx, cand);
}

/** The answer when the menu leaves one legal hold: no Jev call, no cost. */
function requiredAnswer(label: string): JevAnswer {
  return { ok: true, choice: label, probabilities: { [label]: 1 }, confidence: 1, conviction: 0, convictionRaw: 0, inputTokens: 0, costUsd: 0, latencyMs: 0, model: "rules" };
}

const EMPTY_DECISION = { stateHash: "", stateJson: "{}", menuJson: "[]", choice: null, probabilities: null, confidence: null, conviction: null, latencyMs: null, inputTokens: null, jevCostUsd: 0, jevError: null, vetoedBy: null } as const;

export class Engine {
  agent!: AgentState;
  private last: LastDecision | null = null;
  private orderPauseUntil = 0;
  private now: () => number;
  private ticking = false;
  private stopped = false;
  private refreshing = false;
  private timers: NodeJS.Timeout[] = [];
  private lastEquityAt = 0;
  private lastReconAt = 0;
  private lastFundingSlot: number;
  private seq = 0;
  private jevDownAlerted = false;
  private recon: { ok: boolean | null; detail: string; ts: number } = { ok: null, detail: "not run yet", ts: 0 };
  private liveStartedAt: number | null = null;
  private lastPulseAt = 0;
  private lastChipUsd: number | undefined;
  startedAt: number;
  private experimentStartedAt = 0;
  /** Closed: no Jev calls, no new positions; open positions are closed, then the engine only marks and reconciles. */
  private closedAt: number | null = null;
  private closeRetryAt: Record<string, number> = {};
  private closeAnnounced = false;
  private readonly brain: Brain;

  constructor(private d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.startedAt = this.now();
    this.lastFundingSlot = fundingSlot(this.startedAt);
    this.brain = d.brain ?? defaultBrain;
  }

  private get venue(): boolean {
    return this.d.exec.kind !== "sim";
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const { cfg, db } = this.d;
    const storedMode = db.getMeta("mode");
    if (storedMode && storedMode !== cfg.mode) {
      throw new Error(`This database was used for MODE=${storedMode}. Point DB_PATH at a separate file for MODE=${cfg.mode}.`);
    }
    db.setMeta("mode", cfg.mode);
    if (cfg.mode === "live") {
      const s = db.getMeta("live_started_at");
      this.liveStartedAt = s ? Number(s) : this.now();
      if (!s) db.setMeta("live_started_at", String(this.liveStartedAt));
    }
    if (!db.getMeta("funding_since")) db.setMeta("funding_since", String(this.now()));
    if (!db.getMeta("experiment_started_at")) db.setMeta("experiment_started_at", String(this.now()));
    this.experimentStartedAt = Number(db.getMeta("experiment_started_at"));
    const closed = db.getMeta("experiment_closed_at");
    if (closed) {
      this.closedAt = Number(closed);
      this.closeAnnounced = db.getMeta("experiment_flat_at") !== null;
    }

    this.agent = db.loadAgent() ?? freshAgent(cfg.risk.startEquityUsd, this.now());
    await this.d.exec.init();

    await this.refreshMarket();
    if (this.venue) await this.reconcile();

    this.d.bus.emit("status", { event: "engine_start", mode: cfg.mode, tickMs: cfg.tickMs });
    this.d.alerts.send(`agent started (MODE=${cfg.mode})`);

    this.loop(() => this.tick(), cfg.tickMs);
    this.loop(() => this.refreshMarket(), cfg.dataRefreshMs);
    this.timers.push(setInterval(() => this.d.bus.emit("heartbeat", {}), 15_000));
    this.timers.push(setInterval(() => this.d.db.pruneEvents(this.now() - 3 * 86_400_000), 3_600_000));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.d.db.saveAgent(this.agent, this.now());
  }

  private loop(fn: () => Promise<void>, everyMs: number) {
    const slot = this.timers.length;
    const run = async () => {
      const t0 = this.now();
      try {
        await fn();
      } catch (err) {
        log.error("loop error", { err: safeError(err) });
      }
      if (!this.stopped) this.timers[slot] = setTimeout(run, Math.max(0, everyMs - (this.now() - t0)));
    };
    this.timers[slot] = setTimeout(run, everyMs);
  }

  async refreshMarket(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.d.feed.refresh(this.now());
      this.rankMomentumHourly();
      if (this.venue) await this.pollFunding();
    } catch (err) {
      log.warn("market refresh failed", { err: safeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ---------- the tick ----------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      try {
        await this.d.feed.refreshTickers();
      } catch (err) {
        log.warn("ticker refresh failed", { err: safeError(err) });
      }
      const now = this.now();
      this.mark(now);
      if (this.d.feed.lastRefreshAt === 0) return; // no market data yet
      if (!this.venue) this.simulateFunding(now);

      if (this.closedAt === null && this.d.closeRequested?.()) this.beginClose(now);
      if (this.closedAt === null && this.d.takeResumeRequest?.()) await this.resumeLast(now);
      if (this.closedAt !== null) await this.windDown(now);
      else await this.decide(now).catch((err) => log.error("decision failed", { err: safeError(err) }));

      if (now - this.lastEquityAt >= EQUITY_SNAPSHOT_MS) {
        this.lastEquityAt = now;
        const a = this.agent;
        this.d.db.insertEquity(now, a.equityUsd, a.cashUsd, a.uplUsd);
      }
      this.d.bus.emit("equity", this.publicAgent(), now);
      if (this.venue && now - this.lastReconAt >= RECON_MS) await this.reconcile();
      this.checkJevOutage(now);
    } finally {
      this.ticking = false;
    }
  }

  private ctx(now: number): AgentContext {
    return { agent: this.agent, view: this.d.feed.view(), cfg: this.d.cfg, now };
  }

  private lastUpl = new Map<string, number>();

  private mark(now: number) {
    const a = this.agent;
    const view = this.d.feed.view();
    markAll(
      a,
      (instId) => {
        const t = view.tickers.get(instId);
        const inst = view.instruments.get(instId);
        return t && inst && t.mid > 0 ? { px: t.mid, ctVal: inst.ctVal } : null;
      },
      this.lastUpl,
    );
    if (rollDay(a, now)) this.d.bus.emit("cap", { cap: null, detail: "new UTC day: counters and caps reset" }, now);
    const ctx = this.ctx(now);
    for (const p of positionList(a)) {
      const t = view.tickers.get(p.instId);
      // Trailing stop: only ever ratchets in the position's favour.
      const cand = this.brain.trail(p, ctx);
      if (cand !== null && Number.isFinite(cand)) ratchetStop(p, cand);
      // Profit lock: track the best price since entry; past a rung the stop keeps part of that move.
      if (t?.mid) {
        const better = p.peakPx == null || (p.side === "long" ? t.mid > p.peakPx : t.mid < p.peakPx);
        if (better) p.peakPx = t.mid;
        const lock = profitLockStop(p.side, p.entryPx, p.peakPx!, this.brain.profitLock);
        if (lock !== null && Number.isFinite(lock)) ratchetStop(p, lock);
      }
    }
  }

  private async decide(now: number): Promise<void> {
    const { cfg, db, bus, jev } = this.d;
    const brain = this.brain;
    const a = this.agent;
    // Benched (trade cap or fee budget): the agent rides what it holds. Jev is not asked, because nothing it chose
    // could be acted on; only code can close positions (stops, time stops, loss stop) until 00:00 UTC.
    if (a.cap === "trade_cap" || a.cap === "fee_budget") return this.decideBenched(now);
    const ctx = this.ctx(now);
    const menu = brain.menu(ctx);
    const snap = buildSnapshot(brain, ctx);
    if (a.top1.coin) snap.state.top1 = `${a.top1.coin} x${a.top1.streak}`;

    let jevStatus: JevStatus = "ok";
    let r: JevResult | null = null;
    // One legal move and it is "keep what you hold": asking Jev buys nothing, so the rules make the call.
    const labels = Object.keys(menu);
    const required = labels.length === 1 && menu[labels[0]!]!.intent.kind === "hold";
    if (jev.capTripped) jevStatus = "daily_cap";
    else if (labels.length === 0) jevStatus = "no_options";
    else if (required) r = requiredAnswer(labels[0]!);
    else {
      r = await jev.decide({ strategy: brain.strategy, state: snap.state, menu, convictionLabels: brain.convictionLabels });
      if (!r.ok) jevStatus = r.reason === "daily_cap" ? "daily_cap" : "unreachable";
    }
    const proposal: Proposal | null = r && r.ok ? { label: r.choice, intent: menu[r.choice]!.intent, prob: r.probabilities[r.choice] ?? 0, conviction: r.conviction } : null;

    const risk = applyRisk({
      ctx,
      brain,
      proposal,
      jev: jevStatus,
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * cfg.dataRefreshMs + 30_000,
    });

    if (risk.capTripped) {
      db.insertCap(now, risk.capTripped, risk.status);
      bus.emit("cap", { cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(risk.status);
    }
    a.cap = risk.cap;
    const ruled = required && risk.actions.length === 0 && !risk.forcedBy;
    const status = ruled ? `${labels[0]}: required by rules, Jev not asked` : risk.status;

    // Recorded before it is acted on.
    const costUsd = r && r.ok ? r.costUsd : 0;
    const decisionId = db.insertDecision({
      ts: now,
      stateHash: snap.hash,
      stateJson: JSON.stringify(snap.state),
      menuJson: JSON.stringify(Object.keys(menu)),
      choice: r && r.ok ? r.choice : null,
      probabilities: r && r.ok ? r.probabilities : null,
      confidence: r && r.ok ? r.confidence : null,
      conviction: r && r.ok ? r.convictionRaw : null,
      latencyMs: r ? r.latencyMs : null,
      inputTokens: r && r.ok ? r.inputTokens : null,
      jevCostUsd: costUsd,
      jevError: r && !r.ok ? `${r.reason}${r.error ? `: ${r.error.code} ${r.error.message}` : ""}` : null,
      action: risk.actions,
      vetoedBy: risk.vetoedBy,
      forcedBy: risk.forcedBy,
      status,
    });
    a.totals.jevUsd += costUsd;
    a.totals.decisions++;

    const top3 = r && r.ok ? (Object.entries(r.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3) as Array<[string, number]>) : [];
    this.last = { choice: r && r.ok ? r.choice : null, top3: ruled ? [] : top3, confidence: r && r.ok && !ruled ? r.confidence : null, latencyMs: ruled ? null : r ? r.latencyMs : null, status, ts: now, ...(ruled ? { required: true } : {}) };
    // Flat with nothing to ask Jev: a live "watching" row every PULSE_MS instead of a row every tick.
    const watching = jevStatus === "no_options" && risk.actions.length === 0;
    if ((watching || ruled) && now - this.lastPulseAt < PULSE_MS) {
      db.saveAgent(a, now);
      return;
    }
    if (watching || ruled) this.lastPulseAt = now;
    bus.emit(
      "decision",
      {
        choice: r && r.ok ? r.choice : watching ? "WATCHING" : null,
        ...(watching ? { watch: risk.status } : {}),
        probabilities: ruled ? [] : top3.map(([label, p]) => ({ label, p: Number(p.toFixed(3)) })),
        ...(ruled ? { required: true } : {}),
        confidence: r && r.ok && !ruled ? Number(r.confidence.toFixed(3)) : null,
        conviction: r && r.ok && !ruled ? brain.convictionLabels[r.conviction] : null,
        latencyMs: ruled ? null : r ? r.latencyMs : null,
        tokens: r && r.ok && !ruled ? r.inputTokens : null,
        jevUsd: Number(costUsd.toFixed(6)),
        action: risk.actions.map(describeAction).join("; ") || "hold",
        vetoedBy: risk.vetoedBy,
        forcedBy: risk.forcedBy,
        status,
        jev: jevStatus,
        ...this.liveChip(),
      },
      now,
    );

    for (const action of risk.actions) await this.execute(action, decisionId);
    db.saveAgent(a, now);
  }

  // ---------- benched: ride the positions ----------

  private async decideBenched(now: number): Promise<void> {
    const { db } = this.d;
    const a = this.agent;
    const risk = applyRisk({
      ctx: this.ctx(now),
      brain: this.brain,
      proposal: null,
      jev: "no_options",
      sizeMult: this.sizeMult(now),
      dataAgeMs: now - this.d.feed.lastRefreshAt,
      maxDataAgeMs: 3 * this.d.cfg.dataRefreshMs + 30_000,
    });
    if (risk.capTripped) {
      db.insertCap(now, risk.capTripped, risk.status);
      this.d.bus.emit("cap", { cap: risk.capTripped, detail: risk.status }, now);
      this.d.alerts.send(risk.status);
    }
    a.cap = risk.cap;
    this.last = { choice: null, top3: this.last?.top3 ?? [], confidence: null, latencyMs: null, status: risk.status, ts: now };
    if (risk.actions.length) {
      const decisionId = db.insertDecision({ ...EMPTY_DECISION, ts: now, action: risk.actions, forcedBy: risk.forcedBy, status: risk.status });
      this.d.bus.emit("decision", {
        choice: null, probabilities: [], confidence: null, conviction: null, latencyMs: null, tokens: null,
        jevUsd: 0, action: risk.actions.map(describeAction).join("; "), vetoedBy: null, forcedBy: risk.forcedBy, status: risk.status, jev: "no_options",
        ...this.liveChip(),
      }, now);
      for (const action of risk.actions) await this.execute(action, decisionId);
    } else if (now - this.lastPulseAt >= PULSE_MS) {
      this.lastPulseAt = now;
      const n = positionList(a).length;
      this.d.bus.emit("decision", {
        choice: n ? `RIDING ${n}` : "BENCHED", probabilities: [], confidence: null, conviction: null, latencyMs: null,
        tokens: null, jevUsd: 0, action: "hold", vetoedBy: null, forcedBy: null, status: risk.status, jev: "benched", pulse: true,
        ...this.liveChip(),
      }, now);
    }
    db.saveAgent(a, now);
  }

  /** The money right now, for the stream: open P&L (or total P&L when flat) and how it moved since the last row. */
  private liveChip() {
    const a = this.agent;
    const n = positionList(a).length;
    const value = n ? a.uplUsd : a.equityUsd - this.d.cfg.risk.startEquityUsd;
    const prev = this.lastChipUsd;
    this.lastChipUsd = value;
    return { live: { positions: n, valueUsd: Number(value.toFixed(2)), kind: n ? "open" : "total", deltaUsd: prev === undefined ? 0 : Number((value - prev).toFixed(2)) } };
  }

  /**
   * DRY RUN ONLY, one-shot (flag file `resume-last-dry` in the data volume): a benched, flat agent re-opens the last
   * position it held (same coin, side and size, at today's price). Not a trade toward its cap. Refused in live.
   */
  private async resumeLast(now: number): Promise<void> {
    if (this.d.cfg.mode !== "dry") return;
    const a = this.agent;
    if (positionList(a).length || (a.cap !== "trade_cap" && a.cap !== "fee_budget")) return;
    const last = this.d.db.lastOpenOrder();
    if (!last) return;
    const side: Side = last.side === "buy" ? "long" : "short";
    const decisionId = this.d.db.insertDecision({
      ...EMPTY_DECISION, ts: now, action: { kind: "open", instId: last.instId, side }, forcedBy: "resume_last", status: "benched: back into the last position to ride it",
    });
    const ok = await this.order(decisionId, last.instId, last.side, last.contracts, false, "resume_last", "trend");
    if (ok) this.armStops(last.instId);
    this.d.db.saveAgent(a, now);
  }

  // ---------- closing ----------

  private beginClose(now: number) {
    this.closedAt = now;
    this.d.db.setMeta("experiment_closed_at", String(now));
    log.info("close requested: closing every position, no more Jev calls");
    this.d.bus.emit("status", { event: "experiment_closing" }, now);
    this.d.alerts.send("close requested: closing all positions");
  }

  /** Close everything (reduce-only market, through the normal ledger), then idle. */
  private async windDown(now: number): Promise<void> {
    for (const p of positionList(this.agent)) {
      if (now < (this.closeRetryAt[p.instId] ?? 0)) continue;
      const decisionId = this.d.db.insertDecision({
        ...EMPTY_DECISION, ts: now, action: { kind: "close", instId: p.instId, reason: "experiment_closed" }, forcedBy: "experiment_closed", status: "closed: closing position",
      });
      const ok = await this.order(decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "experiment_close", p.lens);
      if (!ok) this.closeRetryAt[p.instId] = now + 10_000;
    }
    this.d.db.saveAgent(this.agent, now);
    if (!this.closeAnnounced && positionList(this.agent).length === 0) {
      this.closeAnnounced = true;
      this.d.db.setMeta("experiment_flat_at", String(now));
      this.lastReconAt = 0; // confirm flat against the venue on the next tick
      this.d.bus.emit("status", { event: "experiment_closed" }, now);
      this.d.alerts.send("closed: the agent is flat");
    }
  }

  // ---------- execution ----------

  private async execute(action: Action, decisionId: number): Promise<void> {
    const a = this.agent;
    const view = this.d.feed.view();
    switch (action.kind) {
      case "none":
        return;
      case "close": {
        const p = a.positions[action.instId];
        if (p) await this.order(decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, action.reason, p.lens);
        return;
      }
      case "trim": {
        const p = a.positions[action.instId];
        if (!p) return;
        const inst = view.instruments.get(p.instId);
        const n = inst ? roundToLot(p.contracts * action.fraction, inst) : 0;
        if (n > 0 && inst && n >= inst.minSz) await this.order(decisionId, p.instId, p.side === "long" ? "sell" : "buy", n, true, "trim", p.lens);
        else log.info("trim rounds to zero, skipped", { coin: coinOf(action.instId) });
        return;
      }
      case "add": {
        const p = a.positions[action.instId];
        if (!p) return;
        const inst = view.instruments.get(p.instId);
        const s = view.stats.get(p.instId);
        const n = inst && s ? contractsFor(action.notionalUsd, inst, s.mid) : 0;
        if (n > 0) {
          const ok = await this.order(decisionId, p.instId, p.side === "long" ? "buy" : "sell", n, false, "add", p.lens);
          const q = a.positions[action.instId];
          // An add raises the average entry; don't let it turn the position into a loser: stop to at least the new average.
          if (ok && q) ratchetStop(q, q.entryPx);
        } else log.info("add rounds to zero contracts, skipped", { coin: p.coin });
        return;
      }
      case "flip": {
        const p = a.positions[action.instId];
        if (p) {
          const ok = await this.order(decisionId, p.instId, p.side === "long" ? "sell" : "buy", p.contracts, true, "flip_close", p.lens);
          if (!ok) return;
        }
        await this.openPosition(decisionId, action.instId, action.side, action.lens, action.notionalUsd);
        return;
      }
      case "open":
        await this.openPosition(decisionId, action.instId, action.side, action.lens, action.notionalUsd);
        return;
    }
  }

  private async openPosition(decisionId: number, instId: string, side: Side, lens: Lens, notionalUsd: number): Promise<void> {
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!inst || !s) return;
    const contracts = contractsFor(notionalUsd, inst, s.mid);
    if (contracts <= 0) {
      log.info("order rounds to zero contracts, skipped", { coin: inst.coin, notionalUsd });
      return;
    }
    const ok = await this.order(decisionId, instId, side === "long" ? "buy" : "sell", contracts, false, "open", lens);
    if (!ok) return;
    this.agent.tradesToday++;
    this.armStops(instId);
  }

  /** After an entry: the code-set stop, 1R and (trend) the entry score. */
  private armStops(instId: string): void {
    const p = this.agent.positions[instId];
    const view = this.d.feed.view();
    const inst = view.instruments.get(instId);
    const s = view.stats.get(instId);
    if (!p || !inst) return;
    const ctx = this.ctx(this.now());
    p.stopPx = this.brain.stopFor(instId, p.side, p.lens, p.entryPx, ctx);
    p.initialStopPx = p.stopPx;
    const notional = positionNotional(p, p.entryPx, inst.ctVal);
    p.riskUsd = p.stopPx !== null ? sizedRiskUsd(p.contracts, inst.ctVal, p.entryPx, p.stopPx) : notional * 0.01;
    if (s?.trend) p.entryScore = s.trend.score;
  }

  /** Record the order, send it, apply the fill. Returns true when it filled. */
  private async order(decisionId: number, instId: string, side: "buy" | "sell", contracts: number, reduceOnly: boolean, purpose: string, lens: Lens): Promise<boolean> {
    const { db, bus, exec } = this.d;
    const now = this.now();
    const inst = this.d.feed.view().instruments.get(instId);
    if (!inst) return false;
    // After the exchange rejects a new order, nothing opens for ORDER_REJECT_PAUSE_MS. Closes are never paused.
    if (!reduceOnly && now < this.orderPauseUntil) {
      log.info("new orders paused after an exchange rejection", { coin: inst.coin, purpose, untilS: Math.round((this.orderPauseUntil - now) / 1000) });
      return false;
    }
    const clOrdId = `pb${now.toString(36)}${(this.seq++ % 1296).toString(36).padStart(2, "0")}`;
    const orderId = db.insertOrder({ decisionId, ts: now, clOrdId, instId, side, contracts, reduceOnly, purpose });
    bus.emit("order", { coin: inst.coin, side, contracts, purpose, clOrdId, state: "sent" }, now);
    const res = await exec.market({ instId, side, contracts, reduceOnly, clOrdId });
    if (!res.ok) {
      db.updateOrder(orderId, res.state, null, `${res.error.code} ${res.error.message}`);
      bus.emit("order", { coin: inst.coin, side, contracts, purpose, state: res.state, error: res.error });
      log.warn("order failed", { coin: inst.coin, purpose, err: res.error });
      if (res.state === "unknown") this.lastReconAt = 0; // reconcile on the next tick
      if (!reduceOnly) {
        this.orderPauseUntil = now + ORDER_REJECT_PAUSE_MS;
        this.d.alerts.send(`${inst.coin} ${purpose} order rejected (${res.error.code} ${res.error.message}); new orders paused ${ORDER_REJECT_PAUSE_MS / 60_000} min`);
      }
      return false;
    }
    db.updateOrder(orderId, "filled", res.ordId, null);
    const a = this.agent;
    const out = applyFill(a, { instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, feeUsd: res.feeUsd, ctVal: inst.ctVal, ts: res.ts, lens });
    const notionalUsd = res.contracts * inst.ctVal * res.avgPx;
    db.insertFill({ orderId, ts: res.ts, instId, coin: inst.coin, side, contracts: res.contracts, px: res.avgPx, notionalUsd, feeUsd: res.feeUsd, realisedUsd: out.realisedUsd });
    if (out.closed) {
      const c = out.closed;
      db.insertTrade({
        openedTs: c.position.openedAt, closedTs: c.closedTs, instId, coin: inst.coin, side: c.position.side, lens: c.position.lens,
        contracts: c.position.maxContracts, entryPx: c.position.entryPx, exitPx: c.exitPx, notionalUsd: c.notionalUsd, pnlUsd: c.pnlUsd, feeUsd: c.feeUsd, reason: purpose,
      });
      bus.emit("trade", { coin: inst.coin, side: c.position.side, lens: c.position.lens, pnlUsd: Number(c.pnlUsd.toFixed(2)), reason: purpose, minutesHeld: Math.round(minutesSince(c.position.openedAt, c.closedTs)) }, res.ts);
    }
    this.mark(now);
    const dir = reduceOnly ? "CLOSE" : side === "buy" ? "LONG" : "SHORT";
    bus.emit("fill", {
      coin: inst.coin,
      side,
      purpose,
      contracts: res.contracts,
      px: res.avgPx,
      notionalUsd: Number(notionalUsd.toFixed(2)),
      feeUsd: Number(res.feeUsd.toFixed(4)),
      realisedUsd: Number(out.realisedUsd.toFixed(2)),
      label: `${dir} ${inst.coin} $${notionalUsd.toFixed(0)}`,
    });
    return true;
  }

  // ---------- funding, reconciliation, ranks ----------

  /** MODE=dry: charge funding at 00/08/16 UTC using the current rate (long pays a positive rate). */
  private simulateFunding(now: number) {
    const slot = fundingSlot(now);
    if (slot === this.lastFundingSlot) return;
    this.lastFundingSlot = slot;
    const view = this.d.feed.view();
    for (const p of positionList(this.agent)) {
      const s = view.stats.get(p.instId);
      const inst = view.instruments.get(p.instId);
      if (!s || !inst || s.fundingPct === null) continue;
      const amount = -(p.side === "long" ? 1 : -1) * (s.fundingPct / 100) * positionNotional(p, s.mid, inst.ctVal);
      if (this.d.db.insertFunding(now, p.instId, amount, `sim-${p.instId}-${slot}`)) {
        applyFunding(this.agent, amount);
        this.d.bus.emit("funding", { coin: p.coin, amountUsd: Number(amount.toFixed(4)) }, now);
      }
    }
  }

  /** MODE=live: record the venue's funding settlements as their own ledger rows (when it reports them). */
  private async pollFunding() {
    const since = Number(this.d.db.getMeta("funding_since") ?? 0);
    const bills = await this.d.exec.fundingBills();
    for (const b of bills ?? []) {
      if (b.ts < since) continue;
      if (this.d.db.insertFunding(b.ts, b.instId, b.amountUsd, b.billId)) {
        applyFunding(this.agent, b.amountUsd);
        this.d.bus.emit("funding", { coin: b.instId ? coinOf(b.instId) : null, amountUsd: b.amountUsd }, b.ts);
      }
    }
  }

  /** Every 5 min (live): our positions and fees vs the venue. On mismatch, adopt the venue's book and go red. */
  async reconcile(): Promise<void> {
    const now = this.now();
    this.lastReconAt = now;
    const view = this.d.feed.view();
    const a = this.agent;
    const ex = await this.d.exec.positions();
    if (ex === null) {
      this.setRecon(false, "could not read venue positions", now);
      return;
    }
    const theirs = new Map(ex.filter((p) => Math.abs(p.pos) > 1e-9).map((p) => [p.instId, p]));
    const diffs: string[] = [];
    let ok = true;
    for (const instId of new Set([...Object.keys(a.positions), ...theirs.keys()])) {
      const ours = a.positions[instId];
      const t = theirs.get(instId);
      const oursSigned = ours ? (ours.side === "long" ? 1 : -1) * ours.contracts : 0;
      const theirSigned = t?.pos ?? 0;
      if (Math.abs(oursSigned - theirSigned) < 1e-9) continue;
      ok = false;
      diffs.push(`${coinOf(instId)} ours ${oursSigned} vs venue ${theirSigned}`);
      // The venue is the truth: rebuild the position from it.
      if (!t) {
        delete a.positions[instId];
        continue;
      }
      const inst = view.instruments.get(instId);
      const side: Side = t.pos > 0 ? "long" : "short";
      const sameSide = ours?.side === side;
      const p: Position = {
        instId,
        coin: inst?.coin ?? coinOf(instId),
        side,
        lens: ours?.lens ?? "trend",
        contracts: Math.abs(t.pos),
        entryPx: t.avgPx,
        openedAt: sameSide && ours ? ours.openedAt : now,
        stopPx: sameSide && ours ? ours.stopPx : null,
        riskUsd: 0,
        initialStopPx: sameSide && ours ? ours.initialStopPx : null,
        peakPx: sameSide && ours ? ours.peakPx : null,
        feesUsd: sameSide && ours ? ours.feesUsd : 0,
        realisedUsd: sameSide && ours ? ours.realisedUsd : 0,
        maxContracts: Math.max(Math.abs(t.pos), sameSide && ours ? ours.maxContracts : 0),
      };
      if (p.stopPx === null) p.stopPx = this.brain.stopFor(instId, side, p.lens, t.avgPx, this.ctx(now));
      p.initialStopPx ??= p.stopPx;
      p.riskUsd = inst ? (p.initialStopPx !== null ? sizedRiskUsd(p.contracts, inst.ctVal, p.entryPx, p.initialStopPx) : p.contracts * inst.ctVal * p.entryPx * 0.01) : 0;
      a.positions[instId] = p;
    }
    a.flatSince = positionList(a).length ? null : (a.flatSince ?? now);

    // Fees to the cent on our recent filled orders.
    const rows = this.d.db.recentVenueOrders(50);
    if (rows.length) {
      const theirFees = await this.d.exec.feesFor([...new Set(rows.map((r) => r.instId))], new Set(rows.map((r) => r.ordId)));
      if (theirFees) {
        const ourSum = rows.filter((r) => theirFees.has(r.ordId)).reduce((s, r) => s + r.fee, 0);
        const theirSum = [...theirFees.values()].reduce((s, b) => s + b, 0);
        if (Math.abs(ourSum - theirSum) >= 0.005) {
          ok = false;
          diffs.push(`fees ours $${ourSum.toFixed(2)} vs venue $${theirSum.toFixed(2)}`);
        }
      }
    }
    this.d.db.insertRecon(now, ok, { detail: ok ? "match" : diffs.join("; ") });
    this.setRecon(ok, ok ? "books match the venue" : diffs.join(" | "), now);
  }

  private setRecon(ok: boolean, detail: string, now: number) {
    const was = this.recon.ok;
    this.recon = { ok, detail, ts: now };
    this.d.bus.emit("recon", { ok, detail }, now);
    if (!ok && was !== false) this.d.alerts.send(`reconciliation mismatch: ${detail}`);
  }

  /** Momentum lens: who is #1 on the hourly rank, and for how many ranks in a row. */
  private rankMomentumHourly() {
    const now = this.now();
    const a = this.agent;
    if (Math.floor(now / 3_600_000) === Math.floor(a.top1.rankedAt / 3_600_000)) return;
    const top = this.brain.snapshotCoins(this.ctx(now))[0];
    if (!top) return;
    const coin = this.d.feed.view().instruments.get(top)?.coin ?? coinOf(top);
    a.top1 = { coin, streak: coin === a.top1.coin ? a.top1.streak + 1 : 1, rankedAt: now };
  }

  private checkJevOutage(now: number) {
    const since = this.d.jev.downSince;
    if (since === null) {
      if (this.jevDownAlerted) this.d.alerts.send("Jev is back");
      this.jevDownAlerted = false;
    } else if (!this.jevDownAlerted && now - since > 5 * 60_000) {
      this.jevDownAlerted = true;
      this.d.alerts.send("Jev unreachable for over 5 minutes: holding");
    }
  }

  private sizeMult(now: number): number {
    const { cfg } = this.d;
    if (cfg.mode !== "live" || this.liveStartedAt === null) return 1;
    return now - this.liveStartedAt < cfg.risk.liveRampHours * 3_600_000 ? cfg.risk.liveSizeMultiplier : 1;
  }

  // ---------- read-only views for the dashboard ----------

  publicPositions() {
    const view = this.d.feed.view();
    const now = this.now();
    return positionList(this.agent).map((p) => {
      const inst = view.instruments.get(p.instId);
      const mid = view.tickers.get(p.instId)?.mid;
      const ctVal = inst?.ctVal ?? 1;
      const upl = mid ? uplUsd(p, mid, ctVal) : 0;
      return {
        instId: p.instId,
        coin: p.coin,
        side: p.side,
        lens: p.lens,
        contracts: p.contracts,
        sizeUsd: mid ? r2(positionNotional(p, mid, ctVal)) : null,
        entryPx: p.entryPx,
        markPx: mid ?? null,
        stopPx: p.stopPx,
        uplUsd: r2(upl),
        uplR: p.riskUsd > 0 ? r2(upl / p.riskUsd) : null,
        feesUsd: r2(p.feesUsd),
        minutesHeld: Math.round(minutesSince(p.openedAt, now)),
      };
    });
  }

  publicAgent() {
    const a = this.agent;
    const start = this.d.cfg.risk.startEquityUsd;
    const ctx = this.ctx(this.now());
    const positions = this.publicPositions();
    return {
      equityUsd: r2(a.equityUsd),
      cashUsd: r2(a.cashUsd),
      uplUsd: r2(a.uplUsd),
      pnlUsd: r2(a.equityUsd - start),
      pnlPct: r2(((a.equityUsd - start) / start) * 100),
      dayPnlUsd: r2(a.equityUsd - a.dayStartEquityUsd),
      peakEquityUsd: r2(a.peakEquityUsd),
      drawdownPct: a.peakEquityUsd > 0 ? r2(((a.peakEquityUsd - a.equityUsd) / a.peakEquityUsd) * 100) : 0,
      positions,
      grossNotionalUsd: r2(grossNotionalUsd(ctx)),
      maxNotionalUsd: r2(maxTotalNotionalUsd(ctx)),
      flatMinutes: positions.length ? null : Math.round(minutesSince(a.flatSince, this.now())),
      tradesToday: a.tradesToday,
      maxTradesPerDay: this.d.cfg.risk.maxTradesPerDay,
      feesTodayUsd: r2(a.feesTodayUsd),
      feeBudgetUsd: this.d.cfg.risk.feeBudgetUsdDay,
      cap: a.cap,
      totals: { feesUsd: r2(a.totals.feesUsd), fundingUsd: r2(a.totals.fundingUsd), jevUsd: Number(a.totals.jevUsd.toFixed(4)), realisedUsd: r2(a.totals.realisedUsd), decisions: a.totals.decisions, orders: a.totals.orders },
      record: { ...a.record, grossWinUsd: r2(a.record.grossWinUsd), grossLossUsd: r2(a.record.grossLossUsd) },
      last: this.last,
    };
  }

  snapshot() {
    const view = this.d.feed.view();
    const coin = (i: string) => view.instruments.get(i)?.coin ?? coinOf(i);
    return {
      ts: this.now(),
      mode: this.d.cfg.mode,
      venue: this.d.exec.kind,
      startedAt: this.experimentStartedAt,
      closed: this.closedAt === null ? null : { at: this.closedAt, flat: positionList(this.agent).length === 0 },
      startEquityUsd: this.d.cfg.risk.startEquityUsd,
      maxLeverage: this.d.cfg.risk.maxLeverage,
      tickMs: this.d.cfg.tickMs,
      agent: this.publicAgent(),
      jev: { spentTodayUsd: Number(this.d.jev.spentTodayUsd.toFixed(4)), dailyCapUsd: this.d.cfg.jev.dailyUsdCap, capTripped: this.d.jev.capTripped, down: this.d.jev.downSince !== null },
      recon: this.recon,
      market: {
        refreshedAt: view.ts,
        universe: [...new Set(view.gated.map(coin))],
        spreadBlocked: view.spreadBlocked.map((i) => {
          const bp = view.tickers.get(i)?.spreadBp;
          return { coin: coin(i), spreadBp: bp !== undefined && Number.isFinite(bp) ? Number(bp.toFixed(1)) : null };
        }),
        attention: view.newsAvailable ? "news" : "volume",
      },
    };
  }

  health() {
    const age = this.now() - this.d.feed.lastRefreshAt;
    return { ok: this.d.feed.lastRefreshAt > 0 && age < 5 * this.d.cfg.dataRefreshMs, mode: this.d.cfg.mode, closed: this.closedAt !== null, flat: positionList(this.agent).length === 0, positions: positionList(this.agent).length, marketAgeMs: age, uptimeS: Math.round((this.now() - this.startedAt) / 1000) };
  }
}

function fundingSlot(ms: number): number {
  const d = new Date(ms);
  const h = d.getUTCHours();
  const slotHour = [...FUNDING_HOURS_UTC].reverse().find((x) => h >= x) ?? 0;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), slotHour);
}

export function describeAction(a: Action): string {
  switch (a.kind) {
    case "none":
      return "hold";
    case "close":
      return `close ${coinOf(a.instId)} (${a.reason})`;
    case "trim":
      return `trim ${coinOf(a.instId)} ${Math.round(a.fraction * 100)}%`;
    case "add":
      return `add ${coinOf(a.instId)} $${a.notionalUsd.toFixed(0)}`;
    case "open":
      return `${a.side} ${coinOf(a.instId)} $${a.notionalUsd.toFixed(0)} [${a.lens}]`;
    case "flip":
      return `flip ${coinOf(a.instId)} to ${a.side} $${a.notionalUsd.toFixed(0)}`;
  }
}
