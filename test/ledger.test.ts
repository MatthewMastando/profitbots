import { describe, expect, it } from "vitest";
import { applyFill, applyFunding, freshAgent, markAll, rollDay, sizedRiskUsd, type LedgerFill } from "../src/ledger.js";
import { NOW } from "./fixtures.js";

const f = (instId: string, side: "buy" | "sell", contracts: number, px: number, over: Partial<LedgerFill> = {}): LedgerFill => ({
  instId,
  coin: instId.split("-")[0]!,
  side,
  contracts,
  px,
  feeUsd: 0,
  ctVal: 0.01,
  ts: NOW,
  lens: "ict",
  ...over,
});
const ENA = "ENA-PERP-INTX";
const SOL = "SOL-PERP-INTX";

describe("ledger: one book, many positions", () => {
  it("opens, marks and closes a long; fees come off cash", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100, { feeUsd: 0.05 }));
    expect(a.positions[ENA]).toMatchObject({ side: "long", contracts: 100, entryPx: 100, lens: "ict", feesUsd: 0.05 });
    expect(a.flatSince).toBeNull();
    const out = applyFill(a, f(ENA, "sell", 100, 102, { feeUsd: 0.051, ts: NOW + 60_000 }));
    expect(out.realisedUsd).toBeCloseTo(2, 10);
    expect(out.closed).toMatchObject({ exitPx: 102, closedTs: NOW + 60_000, notionalUsd: 100 });
    expect(out.closed!.pnlUsd).toBeCloseTo(2 - 0.101, 10);
    expect(a.positions[ENA]).toBeUndefined();
    expect(a.flatSince).toBe(NOW + 60_000);
    expect(a.cashUsd).toBeCloseTo(1000 + 2 - 0.101, 10);
    expect(a.totals.orders).toBe(2);
    expect(a.record).toMatchObject({ wins: 1, losses: 0 });
  });

  it("holds two instruments independently; closing one leaves the other", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100));
    applyFill(a, f(SOL, "sell", 50, 100, { lens: "vprofile" }));
    expect(Object.keys(a.positions)).toHaveLength(2);
    expect(applyFill(a, f(SOL, "buy", 50, 90)).realisedUsd).toBeCloseTo(5, 10);
    expect(Object.keys(a.positions)).toEqual([ENA]);
    expect(a.flatSince).toBeNull();
    expect(a.record.wins).toBe(1);
  });

  it("adding averages the entry, trimming keeps it and scales R", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100));
    const p = a.positions[ENA]!;
    p.stopPx = p.initialStopPx = 90;
    p.riskUsd = sizedRiskUsd(100, 0.01, 100, 90);
    applyFill(a, f(ENA, "buy", 100, 110));
    expect(p.entryPx).toBeCloseTo(105);
    expect(p.riskUsd).toBeCloseTo(200 * 0.01 * 15, 6);
    applyFill(a, f(ENA, "sell", 50, 120));
    expect(p.contracts).toBe(150);
    expect(p.entryPx).toBeCloseTo(105);
    expect(p.riskUsd).toBeCloseTo(0.75 * 200 * 0.01 * 15, 6);
    expect(p.maxContracts).toBe(200);
  });

  it("a fill through zero closes the old position and opens the reverse", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100));
    const out = applyFill(a, f(ENA, "sell", 150, 110, { lens: "vprofile" }));
    expect(out.closed?.pnlUsd).toBeCloseTo(10, 10);
    expect(a.positions[ENA]).toMatchObject({ side: "short", contracts: 50, entryPx: 110, lens: "vprofile" });
  });

  it("a losing round trip lands in the loss column net of fees", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100, { feeUsd: 0.5 }));
    applyFill(a, f(ENA, "sell", 100, 99, { feeUsd: 0.5 }));
    expect(a.record).toMatchObject({ wins: 0, losses: 1 });
    expect(a.record.grossLossUsd).toBeCloseTo(2, 10);
  });

  it("marks unrealised P&L of every position into equity", () => {
    const a = freshAgent(1000, NOW);
    applyFill(a, f(ENA, "buy", 100, 100));
    applyFill(a, f(SOL, "sell", 100, 100));
    const marks: Record<string, number> = { [ENA]: 97, [SOL]: 98 };
    markAll(a, (id) => ({ px: marks[id]!, ctVal: 0.01 }), new Map());
    expect(a.uplUsd).toBeCloseTo(-3 + 2);
    expect(a.equityUsd).toBeCloseTo(999);
  });

  it("funding lands as its own line", () => {
    const a = freshAgent(1000, NOW);
    applyFunding(a, -0.12);
    expect(a.cashUsd).toBeCloseTo(999.88);
    expect(a.totals.fundingUsd).toBeCloseTo(-0.12);
  });

  it("00:00 UTC resets counters and caps, but not retirement", () => {
    const a = { ...freshAgent(1000, NOW), tradesToday: 6, feesTodayUsd: 1.5, cap: "trade_cap" as const };
    expect(rollDay(a, NOW)).toBe(false);
    expect(rollDay(a, NOW + 86_400_000)).toBe(true);
    expect(a).toMatchObject({ tradesToday: 0, feesTodayUsd: 0, cap: null });
    const r = { ...freshAgent(1000, NOW), cap: "retired" as const };
    rollDay(r, NOW + 86_400_000);
    expect(r.cap).toBe("retired");
  });
});
