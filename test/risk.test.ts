// Every cap, gate and forcing rule of the one-agent risk layer.
import { describe, expect, it } from "vitest";
import { brain, ICT_MAX_HOLD_MIN, PROFIT_LOCK, VP_MAX_HOLD_MIN } from "../src/agent/brain.js";
import { grossNotionalUsd, MARGIN_HEADROOM, maxTotalNotionalUsd, profitLockStop } from "../src/agent/common.js";
import type { Intent } from "../src/agent/types.js";
import { applyRisk, evaluateCaps, type JevStatus, type Proposal, type RiskInput } from "../src/risk.js";
import { agent, coin, ctx, ict, NOW, position, profile, testConfig, view, vp, withPositions } from "./fixtures.js";

const open = (instId: string, side: "long" | "short" = "long", sizeFrac = 1, setup: "strict" | "loose" = "strict"): Intent => ({ kind: "open", instId, side, lens: "ict", sizeFrac, setup });
const prop = (intent: Intent, prob = 0.9, conviction = 3, label = "X"): Proposal => ({ label, intent, prob, conviction });
const run = (c: ReturnType<typeof ctx>, proposal: Proposal | null, jev: JevStatus = "ok", extra: Partial<RiskInput> = {}) =>
  applyRisk({ ctx: c, brain, proposal, jev, sizeMult: 1, dataAgeMs: 1000, maxDataAgeMs: 210_000, ...extra });

const SOL = coin("SOL");
const ENA = coin("ENA");
const BTC = coin("BTC", { ict: ict(80000) }, 80000);
const V = view([SOL, ENA, BTC, coin("ETH", {}, 2700)]);

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

  it("ICT positions time out after 12h, profile positions after 48h", () => {
    const i = withPositions(agent(), position(SOL, { lens: "ict", openedAt: NOW - (ICT_MAX_HOLD_MIN + 1) * 60_000 }));
    expect(run(ctx(i, V), prop({ kind: "hold" })).actions[0]).toMatchObject({ reason: "time_stop" });
    const young = withPositions(agent(), position(SOL, { lens: "vprofile", openedAt: NOW - (ICT_MAX_HOLD_MIN + 1) * 60_000 }));
    expect(run(ctx(young, V), prop({ kind: "hold" })).actions).toEqual([]);
    const old = withPositions(agent(), position(SOL, { lens: "vprofile", openedAt: NOW - (VP_MAX_HOLD_MIN + 1) * 60_000 }));
    expect(run(ctx(old, V), prop({ kind: "hold" })).actions[0]).toMatchObject({ reason: "time_stop" });
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
    const a = withPositions(agent(), position(SOL, { lens: "vprofile" }));
    expect(run(ctx(a, V), prop({ kind: "trim", instId: SOL.instId, fraction: 0.5 })).actions[0]).toEqual({ kind: "trim", instId: SOL.instId, fraction: 0.5 });
    expect(run(ctx(a, V), prop({ kind: "flip", instId: SOL.instId, side: "short", lens: "vprofile", sizeFrac: 1 })).actions[0]?.kind).toBe("flip");
    expect(run(ctx(a, V), prop({ kind: "flip", instId: SOL.instId, side: "long", lens: "vprofile", sizeFrac: 1 })).vetoedBy).toBe("invalid_flip");
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
  it("offers ICT and profile opens per setup plus HOLD, and per-position exits", () => {
    const sui = coin("SUI", { ict: ict(1) }, 1);
    const v = view([
      coin("BTC", { ict: ict(80000) }, 80000),
      coin("ETH", { ict: ict(2700, -1) }, 2700),
      coin("SOL", { vp: vp(95, 100, 10) }, 95), // sitting on VAL (value 95..105)
      coin("XRP", { vp: vp(3.25, 3, 0.4, { acceptance: 3 }) }, 3.25),
      sui,
    ]);
    const a = withPositions(agent(), position(sui, { openedAt: NOW - 25 * 3_600_000 }));
    const m = brain.menu(ctx(a, v));
    expect(m.ICT_LONG_BTC?.intent).toMatchObject({ kind: "open", lens: "ict", side: "long", setup: "strict", meta: { setup: "sweep_fvg" } });
    expect(m.ICT_SHORT_ETH?.intent).toMatchObject({ kind: "open", lens: "ict", side: "short" });
    expect(m.VP_ROTATION_LONG_SOL?.intent).toMatchObject({ kind: "open", lens: "vprofile", side: "long", meta: { setup: "rotation", targetPx: 100 } });
    expect(m.VP_ACCEPT_LONG_XRP?.intent).toMatchObject({ kind: "open", lens: "vprofile", side: "long", setup: "strict", meta: { setup: "acceptance" } });
    expect(m.ICT_LONG_SUI).toBeUndefined(); // already held
    expect(m.CLOSE_SUI?.intent).toMatchObject({ kind: "close" });
    expect(m.HOLD).toBeDefined();
  });

  it("an ICT setup whose price has not returned to the zone is offered loose, and the risk layer vetoes it", () => {
    const far = coin("BTC", { ict: ict(80000, 1, { sweep: null, fvg: { lo: 78_000, hi: 78_400, dir: 1, barsAgo: 3 }, orderBlock: null, rangePos: 0.9 }) }, 80000);
    const m = brain.menu(ctx(agent(), view([far])));
    expect(m.ICT_LONG_BTC?.intent).toMatchObject({ setup: "loose", meta: { setup: "ob_retest" } });
    expect(run(ctx(agent(), view([far])), prop(m.ICT_LONG_BTC!.intent)).vetoedBy).toBe("no_setup_yet");
  });

  it("one accepted bar is loose, two are strict; the short side mirrors", () => {
    const one = coin("XRP", { vp: vp(2.7, 3, 0.4, { acceptance: -1 }) }, 2.7);
    const two = coin("XRP", { vp: vp(2.7, 3, 0.4, { acceptance: -2 }) }, 2.7);
    expect(brain.menu(ctx(agent(), view([one]))).VP_ACCEPT_SHORT_XRP?.intent).toMatchObject({ side: "short", setup: "loose" });
    expect(brain.menu(ctx(agent(), view([two]))).VP_ACCEPT_SHORT_XRP?.intent).toMatchObject({ side: "short", setup: "strict" });
  });

  it("the 80% rule offers a trade back across yesterday's value", () => {
    const s = coin("SOL", { vp: vp(97, 100, 10, { prevDay: profile(100, 10), openVsPrevVa: "below", vaPos: 0.5 }) }, 97);
    const m = brain.menu(ctx(agent(), view([s])));
    expect(m.VP_RULE80_LONG_SOL?.intent).toMatchObject({ side: "long", meta: { setup: "rule80", targetPx: 105 } });
  });

  it("caps the number of open-setups shown to Jev, best first", () => {
    const coins = ["A", "B", "C", "D"].map((c, i) => coin(c, { ict: ict(100, 1, { displacement: { dir: 1, barsAgo: 2, atrMult: 1.5 + i, broke: 101 } }) }));
    const m = brain.menu(ctx(agent(), view(coins), testConfig({ MAX_MENU_SETUPS: "2" })));
    expect(Object.keys(m).filter((k) => k.startsWith("ICT_"))).toEqual(["ICT_LONG_D", "ICT_LONG_C"]);
  });

  it("offers TRIM once a profile target is reached and FLIP when structure turns against an ICT position", () => {
    const sol = coin("SOL", { vp: vp(101, 100, 10) }, 101);
    const a = withPositions(agent(), position(sol, { lens: "vprofile", setup: "rotation", targetPx: 100 }));
    expect(brain.menu(ctx(a, view([sol]))).TRIM_SOL).toBeDefined();
    const btc = coin("BTC", { ict: ict(80000, -1) }, 80000);
    const b = withPositions(agent(), position(btc, { lens: "ict", side: "long" }));
    expect(brain.menu(ctx(b, view([btc]))).FLIP_SHORT_BTC?.intent).toMatchObject({ kind: "flip", side: "short", lens: "ict" });
  });

  it("crowded longs (funding z > 1.5) are not offered", () => {
    const hot = coin("BTC", { ict: ict(80000), fundingZ: 2 }, 80000);
    expect(brain.menu(ctx(agent(), view([hot]))).ICT_LONG_BTC).toBeUndefined();
  });
});

describe("stops", () => {
  it("ICT stops sit under the sweep wick / order block, profile stops just outside value, never wider than ATR", () => {
    const btc = coin("BTC", { ict: ict(80000) }, 80000);
    const c = ctx(agent(), view([btc]));
    const stop = brain.stopFor(btc.instId, "long", "ict", 80000, c)!;
    expect(stop).toBeLessThan(80000 * 0.99); // below the OB low (79_200) and the sweep extreme (79_040)
    expect(stop).toBeCloseTo(80000 * 0.988 - 80, 0);
    const sol = coin("SOL", { vp: vp(95, 100, 10) }, 95);
    const vs = brain.stopFor(sol.instId, "long", "vprofile", 95, ctx(agent(), view([sol])))!;
    expect(vs).toBeLessThan(95);
    expect(vs).toBeGreaterThanOrEqual(95 - 95 * 0.005 * 2); // ATR stop = 2 x 0.5%
  });

  it("ICT trails behind the last 15m swing; acceptance trades trail behind the value edge they broke", () => {
    const btc = coin("BTC", { ict: ict(80000) }, 80000);
    expect(brain.trail(position(btc, { lens: "ict" }), ctx(agent(), view([btc])))).toBe(80000 * 0.985);
    const xrp = coin("XRP", { vp: vp(3.3, 3, 0.4, { acceptance: 3 }) }, 3.3);
    expect(brain.trail(position(xrp, { lens: "vprofile", setup: "acceptance" }), ctx(agent(), view([xrp])))).toBeCloseTo(3.2, 10);
    expect(brain.trail(position(xrp, { lens: "vprofile", setup: "rotation" }), ctx(agent(), view([xrp])))).toBeNull();
  });
});
