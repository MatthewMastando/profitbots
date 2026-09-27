// The engine end to end on the sim executor: Jev's pick becomes an order, code stops fire, rejects pause, trades log.
import { describe, expect, it } from "vitest";
import { Alerts } from "../src/alerts.js";
import { Db } from "../src/db.js";
import { Engine, ORDER_REJECT_PAUSE_MS } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SimExecutor, type Executor } from "../src/exec/executor.js";
import { Jev, type SystemOne } from "../src/jev.js";
import type { MarketFeed } from "../src/market/data.js";
import type { MarketView } from "../src/market/types.js";
import { coin, NOW, position, testConfig, view } from "./fixtures.js";

const ENA = (px = 100) => coin("ENA", { ret24hPct: 25, ret7dPct: 43 }, px);
const SUI = () => coin("SUI", { ret24hPct: 12, ret7dPct: 40 });
const BTC = () => coin("BTC", { ret24hPct: 1, ret7dPct: 2 }, 80000);

function fakeJev(answer: () => string, calls?: string[]): SystemOne {
  return {
    async systemOne(req) {
      calls?.push(JSON.stringify(req));
      const a = answer();
      return { model: "fake", usage: { input_tokens: 100, output_tokens: 0 }, answers: { action: { type: "choice", choice: a, confidence: 0.9, probabilities: { [a]: 0.9 } }, conviction: { type: "score", score: 3, confidence: 1, legend: {}, probabilities: {} } } } as never;
    },
  };
}

async function harness(opts: { answer?: () => string; exec?: (v: () => MarketView) => Executor; env?: Record<string, string> } = {}) {
  const cfg = testConfig({ DRY_RUN: "true", EDGE_SIZING: "false", ...opts.env });
  let v = view([ENA(), SUI(), BTC()]);
  let now = NOW;
  const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, get lastRefreshAt() { return now; } } as unknown as MarketFeed;
  const calls: string[] = [];
  const answer = opts.answer ?? (() => "HOLD");
  const db = new Db(":memory:");
  const bus = new EventBus(db);
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  bus.subscribe((_line, e) => events.push(e as never));
  const alerts: string[] = [];
  const exec = opts.exec ? opts.exec(() => v) : new SimExecutor(() => v, cfg.risk.takerFeeRate);
  const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client: fakeJev(answer, calls), now: () => now }), exec, bus, alerts: { send: (t: string) => alerts.push(t) } as unknown as Alerts, now: () => now });
  await engine.start();
  engine.stop();
  return {
    engine,
    db,
    calls,
    events,
    alerts,
    setPx: (ena: number) => {
      v = view([ENA(ena), SUI(), BTC()]);
    },
    advance: (ms: number) => {
      now += ms;
    },
    enaId: ENA().instId,
  };
}

describe("engine + Jev", () => {
  it("asks Jev once per tick with the unified menu, and a MOMENTUM pick opens a sized long", async () => {
    const h = await harness({ answer: () => "MOMENTUM_ENA" });
    await h.engine.tick();
    expect(h.calls).toHaveLength(1);
    const req = JSON.parse(h.calls[0]!) as { questions: { action: { instructions: string; options: unknown } } };
    expect(req.questions.action.instructions).toMatch(/one trading agent/);
    const p = h.engine.agent.positions[h.enaId];
    expect(p).toMatchObject({ side: "long", lens: "momentum", coin: "ENA" });
    expect(p!.stopPx).not.toBeNull();
    expect(h.engine.agent.tradesToday).toBe(1);
    expect(h.db.trades(0, 10)).toHaveLength(0);
    const decision = h.events.find((e) => e.type === "decision");
    expect(decision).toMatchObject({ choice: "MOMENTUM_ENA" });
  });

  it("a stop hit closes the position without asking Jev, and the round trip lands in the trade log", async () => {
    const h = await harness();
    h.engine.agent.positions[h.enaId] = position(ENA(), { entryPx: 100, stopPx: 95, initialStopPx: 95, openedAt: NOW - 3_600_000 });
    h.engine.agent.flatSince = null;
    h.setPx(94);
    await h.engine.tick();
    expect(h.engine.agent.positions[h.enaId]).toBeUndefined();
    const trades = h.db.trades(0, 10);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ coin: "ENA", side: "long", reason: "stop" });
    expect(trades[0]!.pnlUsd).toBeLessThan(0);
    expect(h.events.some((e) => e.type === "trade")).toBe(true);
  });

  it("profit lock: a +6% run locks 65% of it; the stop then sells into the fade", async () => {
    const h = await harness();
    h.engine.agent.positions[h.enaId] = position(ENA(), { entryPx: 100, stopPx: 90, initialStopPx: 90, openedAt: NOW - 3_600_000 });
    h.engine.agent.flatSince = null;
    h.setPx(106);
    await h.engine.tick();
    const p = h.engine.agent.positions[h.enaId]!;
    expect(p.peakPx).toBe(106);
    expect(p.stopPx!).toBeCloseTo(103.9, 6);
    h.setPx(104.5);
    await h.engine.tick();
    expect(h.engine.agent.positions[h.enaId]?.stopPx).toBeCloseTo(103.9, 6);
    h.setPx(103.5);
    await h.engine.tick();
    expect(h.engine.agent.positions[h.enaId]).toBeUndefined();
    expect(h.db.trades(0, 10)[0]!.pnlUsd).toBeGreaterThan(0);
  });

  it("Jev down: holds the book and opens nothing", async () => {
    const client: SystemOne = { async systemOne() { throw new Error("boom"); } };
    const cfg = testConfig({ DRY_RUN: "true" });
    const v = view([ENA(), SUI(), BTC()]);
    const feed = { view: () => v, refresh: async () => {}, refreshTickers: async () => {}, lastRefreshAt: NOW } as unknown as MarketFeed;
    const db = new Db(":memory:");
    const engine = new Engine({ cfg, db, feed, jev: new Jev({ ...cfg.jev, client, now: () => NOW }), exec: new SimExecutor(() => v, cfg.risk.takerFeeRate), bus: new EventBus(db), alerts: new Alerts(undefined), now: () => NOW });
    await engine.start();
    engine.stop();
    await engine.tick();
    expect(Object.keys(engine.agent.positions)).toHaveLength(0);
    expect(engine.snapshot().agent.last?.status).toMatch(/Jev unreachable/);
  });

  it("a rejected order pauses new orders for the pause window, then the agent may try again", async () => {
    const sent: string[] = [];
    const exec = (): Executor => ({
      kind: "sim",
      async init() {},
      async market(req) {
        sent.push(req.instId);
        return { ok: false, state: "rejected", error: { code: "INSUFFICIENT_FUND", message: "insufficient margin" } };
      },
      async positions() { return null; },
      async fundingBills() { return null; },
      async feesFor() { return null; },
    });
    const h = await harness({ answer: () => "MOMENTUM_ENA", exec });
    await h.engine.tick();
    expect(sent).toHaveLength(1);
    for (let i = 0; i < 20; i++) {
      h.advance(5_000);
      await h.engine.tick();
    }
    expect(sent).toHaveLength(1);
    expect(h.alerts.filter((a) => a.includes("rejected"))).toHaveLength(1);
    h.advance(ORDER_REJECT_PAUSE_MS);
    await h.engine.tick();
    expect(sent).toHaveLength(2);
  });

  it("snapshot exposes one agent with its positions and the analytics totals", async () => {
    const h = await harness({ answer: () => "MOMENTUM_ENA" });
    await h.engine.tick();
    const s = h.engine.snapshot();
    expect(s.agent.equityUsd).toBeGreaterThan(0);
    expect(s.agent.positions).toHaveLength(1);
    expect(s.agent.positions[0]).toMatchObject({ coin: "ENA", side: "long" });
    expect(s.agent.grossNotionalUsd).toBeGreaterThan(0);
    expect(h.engine.health()).toMatchObject({ ok: true, positions: 1 });
  });
});
