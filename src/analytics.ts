// Performance analytics for the dashboard, computed from the ledger tables. Pure given a Db and a window.
import type { Db, TradeOut } from "./db.js";

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
  jev: ReturnType<Db["jevStats"]>;
  /** Annualised Sharpe from daily equity changes (null under 3 days). */
  sharpe: number | null;
}

const r2 = (x: number) => Number(x.toFixed(2));

function breakdown(trades: TradeOut[], key: (t: TradeOut) => string): Breakdown[] {
  const m = new Map<string, { n: number; pnl: number; wins: number }>();
  for (const t of trades) {
    const k = key(t);
    const e = m.get(k) ?? { n: 0, pnl: 0, wins: 0 };
    e.n++;
    e.pnl += t.pnlUsd;
    if (t.pnlUsd >= 0) e.wins++;
    m.set(k, e);
  }
  return [...m.entries()].map(([k, e]) => ({ key: k, trades: e.n, pnlUsd: r2(e.pnl), winRate: e.n ? r2((e.wins / e.n) * 100) : null })).sort((a, b) => b.pnlUsd - a.pnlUsd);
}

/** Max peak-to-trough drawdown over an equity series. */
export function maxDrawdown(series: Array<[number, number]>): { pct: number; usd: number } {
  let peak = -Infinity;
  let ddPct = 0;
  let ddUsd = 0;
  for (const [, eq] of series) {
    peak = Math.max(peak, eq);
    if (peak > 0) {
      ddUsd = Math.max(ddUsd, peak - eq);
      ddPct = Math.max(ddPct, ((peak - eq) / peak) * 100);
    }
  }
  return { pct: r2(ddPct), usd: r2(ddUsd) };
}

export function sharpeFromDaily(daily: Array<{ equityUsd: number }>): number | null {
  if (daily.length < 3) return null;
  const rets: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const a = daily[i - 1]!.equityUsd;
    const b = daily[i]!.equityUsd;
    if (a > 0) rets.push(b / a - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
  return sd > 0 ? r2((mean / sd) * Math.sqrt(365)) : null;
}

export function computeAnalytics(db: Db, sinceTs: number, now: number): Analytics {
  const series = db.equitySeries(sinceTs, 2000, now);
  const start = db.equityBefore(sinceTs) ?? series[0]?.[1] ?? null;
  const end = series.at(-1)?.[1] ?? start;
  const dd = maxDrawdown(start !== null ? [[sinceTs, start], ...series] : series);
  const dailyEq = db.dailyEquity(sinceTs);
  let prev = start;
  const daily = dailyEq.map((d) => {
    const pnl = prev === null ? 0 : d.equityUsd - prev;
    prev = d.equityUsd;
    return { day: d.day, equityUsd: d.equityUsd, pnlUsd: r2(pnl) };
  });

  const trades = db.trades(sinceTs, 10_000);
  const wins = trades.filter((t) => t.pnlUsd >= 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnlUsd, 0);
  const n = trades.length;
  const holdMin = trades.reduce((s, t) => s + (t.closedTs - t.openedTs) / 60_000, 0);

  const costs = db.costsSince(sinceTs);
  return {
    sinceTs,
    ts: now,
    equity: {
      start: start === null ? null : r2(start),
      end: end === null ? null : r2(end),
      pnlUsd: start === null || end === null ? null : r2(end - start),
      pnlPct: start === null || end === null || start <= 0 ? null : r2(((end - start) / start) * 100),
      peak: series.length ? r2(Math.max(...series.map((s) => s[1]), start ?? -Infinity)) : start === null ? null : r2(start),
      maxDrawdownPct: series.length ? dd.pct : null,
      maxDrawdownUsd: series.length ? dd.usd : null,
    },
    daily,
    trades: {
      count: n,
      wins: wins.length,
      losses: losses.length,
      winRate: n ? r2((wins.length / n) * 100) : null,
      profitFactor: grossLoss > 0 ? r2(grossWin / grossLoss) : n && grossWin > 0 ? Infinity : null,
      avgWinUsd: wins.length ? r2(grossWin / wins.length) : null,
      avgLossUsd: losses.length ? r2(-grossLoss / losses.length) : null,
      expectancyUsd: n ? r2((grossWin - grossLoss) / n) : null,
      avgHoldMinutes: n ? Math.round(holdMin / n) : null,
      bestUsd: n ? r2(Math.max(...trades.map((t) => t.pnlUsd))) : null,
      worstUsd: n ? r2(Math.min(...trades.map((t) => t.pnlUsd))) : null,
    },
    byCoin: breakdown(trades, (t) => t.coin),
    bySide: breakdown(trades, (t) => t.side),
    byLens: breakdown(trades, (t) => t.lens),
    byReason: breakdown(trades, (t) => t.reason),
    costs: { feesUsd: r2(costs.feesUsd), fundingUsd: r2(costs.fundingUsd), jevUsd: Number(costs.jevUsd.toFixed(4)), totalUsd: r2(costs.feesUsd - costs.fundingUsd + costs.jevUsd) },
    jev: db.jevStats(sinceTs),
    sharpe: sharpeFromDaily(dailyEq),
  };
}
