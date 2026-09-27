// Every cap, gate and forcing rule of the one-agent risk layer.
import { describe, expect, it } from "vitest";
import { brain, PROFIT_LOCK } from "../src/agent/brain.js";
import { grossNotionalUsd, MARGIN_HEADROOM, maxTotalNotionalUsd, profitLockStop } from "../src/agent/common.js";
import type { Intent } from "../src/agent/types.js";
import { applyRisk, evaluateCaps, type JevStatus, type Proposal, type RiskInput } from "../src/risk.js";
import { agent, coin, ctx, NOW, position, testConfig, trend, view, withPositions } from "./fixtures.js";

const open = (instId: string, side: "long" | "short" = "long", sizeFrac = 1, setup: "strict" | "loose" = "strict"): Intent => ({ kind: "open", instId, side, lens: "momentum", sizeFrac, setup });
const prop = (intent: Intent, prob = 0.9, conviction = 3, label = "X"): Proposal => ({ label, intent, prob, conviction });
const run = (c: ReturnType<typeof ctx>, proposal: Proposal | null, jev: JevStatus = "ok", extra: Partial<RiskInput> = {}) =>
  applyRisk({ ctx: c, brain, proposal, jev, sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 210_000, ...extra });

const SOL = coin("SOL");
const ENA = coin("ENA");
const BTC = coin("BTC", { trend: trend({ score: 5 }) }, 80000);
const V = view([SOL, ENA, BTC, coin("ETH", { trend: trend({ score: -2 }) }, 2700)]);

describe("caps", () => {
  it("daily loss stop trips at -8% and stays quiet at -7.9%", () => {
    expect(evaluateCaps(ctx(agent({ equityUsd: 920, dayStartEquityUsd: 1000 }), V)).cap).toBe("loss_stop");
    expect(evaluateCaps(ctx(agent({ equityUsd: 921, dayStartEquityUsd: 1000 }), V)).cap).toBeNull();
  });

  it("retire line trips at 40% of start", () => {
    expect(evaluateCaps(ctx(agent({ equityUsd: 400, dayStartEquityUsd: 400 }), V)).cap).toBe("retired");
    expect(evaluateCaps(ctx(agent({ equityUsd: 401, dayStartEquityUsd: 401 }), V)).cap).toBeNull();
  });

  it("trade cap and fee budget trip at the max, and only report once", () => {
    expect(evaluateCaps(ctx(agent({ tradesToday: 12 }), V))).toEqual({ cap: "trade_cap", tripped: "trade_cap" });
    expect(evaluateCaps(ctx(agent({ tradesToday: 11 }), V)).cap).toBeNull();
    expect(evaluateCaps(ctx(agent({ feesTodayUsd: 25 }), V)).cap).toBe("fee_budget");
    expect(evaluateCaps(ctx(agent({ tradesToday: 12, cap: "trade_cap" }), V)).tripped).toBeNull();
  });
});

describe("forced closes", () => {
  it("loss stop closes every position, even if Jev says hold", () => {
    const a = withPositions(agent({ equityUsd: 900, dayStartEquityUsd: 1000 }), position(SOL), position(ENA, { side: "short" }));
    const r = run(ctx(a, V), prop({ kind: "hold" }));
    expect(r.actions).toEqual([
      { kind: "close", instId: SOL.instId, reason: "loss_stop" },
      { kind: "close", instId: ENA.instId, reason: "loss_stop" },
    ]);
    expect(r.forcedBy).toBe("loss_stop");
  });

  it("when flat and stopped for the day, never forces an entry", () => {
    const r = run(ctx(agent({ equityUsd: 900, dayStartEquityUsd: 1000 }), V), prop(open(SOL.instId)));
    expect(r.actions).toEqual([]);
    expect(r.status).toMatch(/loss stop/);
  });

  it("a stop fires only for the position that crossed it, and Jev's open still goes through for another coin", () => {
    const a = withPositions(agent(), position(SOL, { stopPx: 100.5 }), position(ENA, { stopPx: 90 }));
    const r = run(ctx(a, V), prop(open(BTC.instId)));
    expect(r.actions[0]).toEqual({ kind: "close", instId: SOL.instId, reason: "stop" });
    expect(r.actions[1]).toMatchObject({ kind: "open", instId: BTC.instId });
    expect(r.forcedBy).toBe("stop");
  });

  it("short stop fires above; stops fire while Jev is unreachable", () => {
    const a = withPositions(agent(), position(SOL, { side: "short", stopPx: 99.5 }));
    expect(run(ctx(a, V), null, "unreachable").actions).toEqual([{ kind: "close", instId: SOL.instId, reason: "stop" }]);
  });

  it("breakout positions get a time stop before the UTC close", () => {
    const a = withPositions(agent(), position(SOL, { lens: "breakout", openedAt: NOW - 13 * 3_600_000 }));
    expect(run(ctx(a, V, testConfig(), Date.UTC(2026, 8, 24, 23, 59, 30)), prop({ kind: "hold" })).actions[0]).toMatchObject({ reason: "time_stop" });
  });

  it("Jev's close for a position that is already stopping is dropped", () => {
    const a = withPositions(agent(), position(SOL, { stopPx: 101 }));
    const r = run(ctx(a, V), prop({ kind: "close", instId: SOL.instId, reason: "jev_close" }));
    expect(r.actions).toHaveLength(1);
    expect(r.vetoedBy).toBe("already_closing");
  });
});

describe("Jev fail-closed", () => {
  it("unreachable and daily cap hold; nothing opens", () => {
    expect(run(ctx(agent(), V), null, "unreachable")).toMatchObject({ actions: [], vetoedBy: "jev_unreachable" });
    expect(run(ctx(agent(), V), null, "daily_cap")).toMatchObject({ actions: [], vetoedBy: "jev_daily_cap" });
  });
  it("an empty menu means no call and an idle status", () => {
    expect(run(ctx(agent(), V), null, "no_options").status).toMatch(/watching/);
  });
});

describe("opening gates", () => {
  it("weak probability or conviction vetoes", () => {
    expect(run(ctx(agent(), V), prop(open(SOL.instId), 0.5)).vetoedBy).toMatch(/weak_conviction/);
    expect(run(ctx(agent(), V), prop(open(SOL.instId), 0.9, 0)).vetoedBy).toMatch(/weak_conviction/);
  });

  it("stale data, cooldown, spread, funding and loose setups veto", () => {
    expect(run(ctx(agent(), V), prop(open(SOL.instId)), "ok", { dataAgeMs: 300_000 }).vetoedBy).toBe("stale_market_data");
    expect(run(ctx(agent({ lastOrderAt: NOW - 60_000 }), V), prop(open(SOL.instId))).vetoedBy).toMatch(/cooldown/);
    expect(run(ctx(agent(), view([coin("SOL", { spreadBp: 30 })])), prop(open(SOL.instId))).vetoedBy).toMatch(/spread_gate/);
    expect(run(ctx(agent(), view([coin("SOL", { fundingZ: 2 })])), prop(open(SOL.instId))).vetoedBy).toMatch(/funding_veto/);
    expect(run(ctx(agent(), V), prop(open(SOL.instId, "long", 1, "loose"))).vetoedBy).toBe("no_setup_yet");
  });

  it("trade cap / fee budget veto opens but leave the book riding", () => {
    const a = withPositions(agent({ tradesToday: 12 }), position(SOL));
    const r = run(ctx(a, V), prop(open(ENA.instId)));
    expect(r.actions).toEqual([]);
    expect(r.vetoedBy).toBe("trade_cap");
    expect(r.status).toMatch(/riding 1 position/);
  });

  it("an open is sized to the per-position cap: maxPositionFrac of the total notional cap", () => {
    const cfg = testConfig({ MAX_LEVERAGE: "3", MAX_POSITION_FRAC: "0.5", EDGE_SIZING: "false" });
    const c = ctx(agent(), V, cfg);
    const total = maxTotalNotionalUsd(c);
    expect(total).toBeCloseTo(Math.min(3 * 1000 * MARGIN_HEADROOM, 10_000));
    const r = run(c, prop(open(SOL.instId)));
    expect(r.actions[0]).toMatchObject({ kind: "open", notionalUsd: total * 0.5 });
  });

  it("the total notional cap is the ceiling across positions: the last open only gets the room left", () => {
    const cfg = testConfig({ MAX_LEVERAGE: "2", MAX_POSITION_FRAC: "0.5", EDGE_SIZING: "false" });
    // Two positions of $800 each on a $1940 cap leaves $340.
    const a = withPositions(agent(), position(SOL, { contracts: 800 }), position(ENA, { contracts: 800 }));
    const c = ctx(a, V, cfg);
    expect(grossNotionalUsd(c)).toBeCloseTo(1600);
    const r = run(c, prop(open(BTC.instId)));
    expect(r.actions[0]).toMatchObject({ kind: "open", notionalUsd: expect.closeTo(1940 - 1600, 6) });
  });

  it("a full book vetoes with below_min_size rather than opening dust", () => {
    const cfg = testConfig({ MAX_LEVERAGE: "1", MAX_TOTAL_NOTIONAL_USD: "1000", EDGE_SIZING: "false" });
    const a = withPositions(agent(), position(SOL, { contracts: 970 }));
    expect(run(ctx(a, V, cfg), prop(open(ENA.instId))).vetoedBy).toMatch(/below_min_size/);
  });

  it("MAX_POSITIONS=0 is unlimited; a positive value caps the count", () => {
    const a = withPositions(agent(), position(SOL), position(ENA));
    expect(run(ctx(a, V, testConfig({ MAX_POSITIONS: "0" })), prop(open(BTC.instId))).actions[0]?.kind).toBe("open");
    expect(run(ctx(a, V, testConfig({ MAX_POSITIONS: "2" })), prop(open(BTC.instId))).vetoedBy).toBe("max_positions");
  });

  it("the live ramp multiplier shrinks the size", () => {
    const cfg = testConfig({ EDGE_SIZING: "false" });
    const full = run(ctx(agent(), V, cfg), prop(open(SOL.instId))).actions[0];
    const ramp = run(ctx(agent(), V, cfg), prop(open(SOL.instId)), "ok", { sizeMult: 0.25 }).actions[0];
    expect(ramp).toMatchObject({ kind: "open", notionalUsd: (full as { notionalUsd: number }).notionalUsd * 0.25 });
  });

  it("adds go only to winners and only within the room left", () => {
    const losing = withPositions(agent(), position(SOL, { entryPx: 101, riskUsd: 10 }));
    expect(run(ctx(losing, V), prop({ kind: "add", instId: SOL.instId, sizeFrac: 0.25 })).vetoedBy).toBe("add_only_to_winners");
    const winning = withPositions(agent(), position(SOL, { entryPx: 90, riskUsd: 1 }));
    expect(run(ctx(winning, V), prop({ kind: "add", instId: SOL.instId, sizeFrac: 0.25 })).actions[0]?.kind).toBe("add");
  });

  it("closes, trims and flips need the position to exist", () => {
    expect(run(ctx(agent(), V), prop({ kind: "close", instId: SOL.instId, reason: "jev_close" })).vetoedBy).toBe("invalid_while_flat");
    const a = withPositions(agent(), position(SOL, { lens: "trend" }));
    expect(run(ctx(a, V), prop({ kind: "trim", instId: SOL.instId, fraction: 0.5 })).actions[0]).toEqual({ kind: "trim", instId: SOL.instId, fraction: 0.5 });
    expect(run(ctx(a, V), prop({ kind: "flip", instId: SOL.instId, side: "short", lens: "trend", sizeFrac: 1 })).actions[0]?.kind).toBe("flip");
    expect(run(ctx(a, V), prop({ kind: "flip", instId: SOL.instId, side: "long", lens: "trend", sizeFrac: 1 })).vetoedBy).toBe("invalid_flip");
  });
});

describe("edge sizing", () => {
  it("scales opens by realised edge once 20 round trips are in", () => {
    const cfg = testConfig({ EDGE_SIZING: "true" });
    const noHistory = run(ctx(agent(), V, cfg), prop(open(SOL.instId))).actions[0] as { notionalUsd: number };
    const losers = run(ctx(agent({ record: { wins: 5, losses: 20, grossWinUsd: 50, grossLossUsd: 400 } }), V, cfg), prop(open(SOL.instId))).actions[0] as { notionalUsd: number };
    const winners = run(ctx(agent({ record: { wins: 15, losses: 10, grossWinUsd: 600, grossLossUsd: 200 } }), V, cfg), prop(open(SOL.instId))).actions[0] as { notionalUsd: number };
    expect(losers.notionalUsd).toBeLessThan(noHistory.notionalUsd);
    expect(winners.notionalUsd).toBeGreaterThanOrEqual(noHistory.notionalUsd);
  });
});

describe("profit lock", () => {
  it("nothing below +2.5%, half the move at +2.5%, 65% at +5%, mirrored for shorts", () => {
    expect(profitLockStop("long", 100, 102.4, PROFIT_LOCK)).toBeNull();
    expect(profitLockStop("long", 100, 103, PROFIT_LOCK)).toBeCloseTo(101.5, 10);
    expect(profitLockStop("long", 100, 110, PROFIT_LOCK)).toBeCloseTo(106.5, 10);
    expect(profitLockStop("short", 100, 94, PROFIT_LOCK)).toBeCloseTo(96.1, 10);
  });
});

describe("menu", () => {
  it("offers a lens open per setup plus HOLD, and per-position exits", () => {
    const v = view([coin("BTC", { trend: trend({ score: 5 }), breakout: { trigger: 79_000, dayOpen: 78_000, prevRange: 2000 } }, 80000), coin("ENA", { ret24hPct: 25, ret7dPct: 43 }), coin("SUI", { ret24hPct: 12, ret7dPct: 40 })]);
    const a = withPositions(agent(), position(SUI, { openedAt: NOW - 25 * 3_600_000 }));
    const m = brain.menu(ctx(a, v));
    expect(m.TREND_LONG_BTC?.intent).toMatchObject({ kind: "open", lens: "trend", side: "long" });
    expect(m.BREAKOUT_BTC?.intent).toMatchObject({ kind: "open", lens: "breakout" });
    expect(m.MOMENTUM_ENA?.intent).toMatchObject({ kind: "open", lens: "momentum" });
    expect(m.MOMENTUM_SUI).toBeUndefined(); // already held
    expect(m.CLOSE_SUI?.intent).toMatchObject({ kind: "close" });
    expect(m.HOLD).toBeDefined();
  });

  it("a momentum position inside its 24h lock has no CLOSE on the menu", () => {
    const a = withPositions(agent(), position(SUI, { openedAt: NOW - 3_600_000 }));
    expect(brain.menu(ctx(a, view([SUI]))).CLOSE_SUI).toBeUndefined();
  });
});
const SUI = coin("SUI", { ret24hPct: 12, ret7dPct: 40 });
