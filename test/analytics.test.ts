// Performance analytics over the trade/equity tables, and the read-only HTTP API that serves them.
import { afterAll, describe, expect, it } from "vitest";
import { computeAnalytics, maxDrawdown, sharpeFromDaily } from "../src/analytics.js";
import { Db, type TradeRow } from "../src/db.js";
import { EventBus } from "../src/events.js";
import { startServer } from "../src/server.js";
import { NOW } from "./fixtures.js";

const DAY = 86_400_000;
const trade = (over: Partial<TradeRow> & { closedTs: number }): TradeRow => ({ openedTs: over.closedTs - 3_600_000, instId: "SOL-PERP-INTX", coin: "SOL", side: "long", lens: "momentum", contracts: 10, entryPx: 100, exitPx: 101, notionalUsd: 1000, pnlUsd: 10, feeUsd: 0.5, reason: "jev_close", ...over });

function seeded(): Db {
  const db = new Db(":memory:");
  const eq = [1000, 1020, 990, 1050, 1030];
  eq.forEach((e, i) => db.insertEquity(NOW - (eq.length - 1 - i) * DAY, e, e, 0));
  db.insertTrade(trade({ pnlUsd: 20, closedTs: NOW - 4 * DAY + 1000 }));
  db.insertTrade(trade({ pnlUsd: -30, coin: "ENA", instId: "ENA-PERP-INTX", side: "short", lens: "trend", reason: "stop", closedTs: NOW - 3 * DAY + 1000 }));
  db.insertTrade(trade({ pnlUsd: 60, coin: "SOL", lens: "breakout", closedTs: NOW - 2 * DAY + 1000 }));
  db.insertTrade(trade({ pnlUsd: -20, coin: "BTC", instId: "BTC-PERP-INTX", side: "short", reason: "stop", closedTs: NOW - DAY + 1000 }));
  db.insertFunding(NOW - DAY, "SOL-PERP-INTX", -1.5, "f1");
  for (let i = 0; i < 3; i++) {
    db.insertDecision({ ts: NOW - i * 60_000, stateHash: null, stateJson: null, menuJson: null, choice: i === 2 ? null : "HOLD", probabilities: null, confidence: 0.8, conviction: 2, latencyMs: 400, inputTokens: 1000, jevCostUsd: 0.01, jevError: i === 2 ? "timeout" : null, action: null, vetoedBy: i === 1 ? "cooldown" : null, forcedBy: null, status: "s" });
  }
  return db;
}

describe("analytics math", () => {
  it("max drawdown is the worst peak-to-trough, in pct and usd", () => {
    expect(maxDrawdown([[0, 1000], [1, 1100], [2, 990], [3, 1200], [4, 1080]])).toEqual({ pct: 10, usd: 120 });
    expect(maxDrawdown([[0, 1000], [1, 1010]])).toEqual({ pct: 0, usd: 0 });
    expect(maxDrawdown([])).toEqual({ pct: 0, usd: 0 });
  });

  it("sharpe annualises daily returns and needs at least three days", () => {
    expect(sharpeFromDaily([{ equityUsd: 1000 }, { equityUsd: 1010 }])).toBeNull();
    const up = sharpeFromDaily([{ equityUsd: 1000 }, { equityUsd: 1010 }, { equityUsd: 1015 }, { equityUsd: 1030 }, { equityUsd: 1035 }]);
    expect(up).toBeGreaterThan(0);
    expect(sharpeFromDaily([{ equityUsd: 1000 }, { equityUsd: 1000 }, { equityUsd: 1000 }])).toBeNull();
  });
});

describe("computeAnalytics", () => {
  it("rolls trades, equity, costs and Jev stats into one report", () => {
    const db = seeded();
    const a = computeAnalytics(db, NOW - 10 * DAY, NOW);
    expect(a.equity).toMatchObject({ start: 1000, end: 1030, pnlUsd: 30, pnlPct: 3, peak: 1050 });
    expect(a.equity.maxDrawdownPct).toBeCloseTo((30 / 1020) * 100);
    expect(a.trades).toMatchObject({ count: 4, wins: 2, losses: 2, winRate: 50, avgWinUsd: 40, avgLossUsd: -25, bestUsd: 60, worstUsd: -30 });
    expect(a.trades.profitFactor).toBeCloseTo(80 / 50);
    expect(a.trades.expectancyUsd).toBeCloseTo(7.5);
    expect(a.trades.avgHoldMinutes).toBe(60);
    expect(a.byCoin.find((b) => b.key === "SOL")).toMatchObject({ trades: 2, pnlUsd: 80, winRate: 100 });
    expect(a.bySide.find((b) => b.key === "short")).toMatchObject({ trades: 2, pnlUsd: -50, winRate: 0 });
    expect(a.byLens.map((b) => b.key).sort()).toEqual(["breakout", "momentum", "trend"]);
    expect(a.byReason.find((b) => b.key === "stop")?.trades).toBe(2);
    expect(a.costs).toMatchObject({ feesUsd: 0, fundingUsd: -1.5 });
    expect(a.costs.totalUsd).toBeCloseTo(1.5 + 0.03);
    expect(a.costs.jevUsd).toBeCloseTo(0.03);
    expect(a.jev).toMatchObject({ decisions: 3, errors: 1 });
    expect(a.jev.vetoes).toEqual([{ reason: "cooldown", n: 1 }]);
    expect(a.daily).toHaveLength(5);
    expect(a.daily.at(-1)!.pnlUsd).toBe(-20);
  });

  it("an empty book is all nulls, not NaN", () => {
    const a = computeAnalytics(new Db(":memory:"), 0, NOW);
    expect(a.trades).toMatchObject({ count: 0, winRate: null, profitFactor: null, expectancyUsd: null });
    expect(a.equity.pnlUsd).toBeNull();
    expect(a.sharpe).toBeNull();
  });
});

describe("http api", () => {
  const db = seeded();
  const bus = new EventBus(db);
  const server = startServer(
    {
      bus,
      db,
      snapshot: () => ({ mode: "dry", agent: { equityUsd: 1030, positions: [] }, secret: "TYPESAFE_API_KEY=abc" }),
      health: () => ({ ok: true, positions: 0 }),
      profile: () => ({ mode: "dry", venue: "Coinbase Derivatives" }),
      now: () => NOW,
    },
    0,
    "127.0.0.1",
  );
  const base = () => {
    const a = server.address();
    return typeof a === "object" && a ? `http://127.0.0.1:${a.port}` : "";
  };
  const get = async (p: string) => {
    const r = await fetch(base() + p);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> & unknown[] };
  };
  afterAll(() => server.close());

  it("serves profile, health and snapshot; the snapshot is redacted and read-only", async () => {
    expect((await get("/profile")).body).toMatchObject({ venue: "Coinbase Derivatives" });
    expect((await get("/health")).status).toBe(200);
    const s = await get("/snapshot");
    expect(s.body.agent).toMatchObject({ equityUsd: 1030 });
    expect(JSON.stringify(s.body)).not.toContain("=abc");
    expect((await fetch(base() + "/snapshot", { method: "POST" })).status).toBe(405);
  });

  it("serves analytics, trades and equity with bounded windows", async () => {
    const a = await get("/analytics?days=30");
    expect(a.body.trades).toMatchObject({ count: 4 });
    const t = await get("/trades?days=2&n=10");
    expect((t.body as unknown as unknown[]).length).toBe(2);
    const e = await get("/equity?days=30");
    expect((e.body as unknown as unknown[]).length).toBeGreaterThanOrEqual(2);
    expect((await get("/nope")).status).toBe(404);
  });
});
