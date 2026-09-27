// Numeric snapshot for Jev. Numbers only, columnar, small.
import { createHash } from "node:crypto";
import { grossNotionalUsd, maxTotalNotionalUsd, minutesSince, r2 } from "./agent/common.js";
import { positionList, type AgentContext, type Brain } from "./agent/types.js";

export interface Snapshot {
  state: Record<string, unknown>;
  /** First 16 hex chars of sha256(state). */
  hash: string;
  /** Rough size guard; the real number comes back as usage.input_tokens. */
  approxTokens: number;
}

/** The book in one line: exposure, room, day P&L, trades and fee budget left. */
export function bookLine(ctx: AgentContext): Record<string, number | string | null> {
  const { agent, cfg, now } = ctx;
  const gross = grossNotionalUsd(ctx);
  const max = maxTotalNotionalUsd(ctx);
  return {
    positions: positionList(agent).length,
    gross_usd: r2(gross, 0),
    room_usd: r2(Math.max(0, max - gross), 0),
    upl_usd: r2(agent.uplUsd, 0),
    day_pnl_pct: r2(((agent.equityUsd - agent.dayStartEquityUsd) / agent.dayStartEquityUsd) * 100, 1),
    flat_min: positionList(agent).length ? null : r2(minutesSince(agent.flatSince, now), 0),
    trades: `${agent.tradesToday}/${cfg.risk.maxTradesPerDay}`,
    fee_left: r2(cfg.risk.feeBudgetUsdDay - agent.feesTodayUsd),
  };
}

export function buildSnapshot(brain: Brain, ctx: AgentContext): Snapshot {
  const ids = brain.snapshotCoins(ctx);
  let cols: string[] = [];
  const rows: Record<string, Array<number | string | null>> = {};
  for (const id of ids) {
    const s = ctx.view.stats.get(id);
    if (!s) continue;
    const snap = brain.coinSnapshot(s, ctx);
    if (!cols.length) cols = Object.keys(snap);
    rows[s.coin] = cols.map((c) => snap[c] ?? null);
  }
  const d = new Date(ctx.now);
  const state: Record<string, unknown> = {
    utc: `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`,
    book: bookLine(ctx),
    coins: { cols, rows },
    attn: ctx.view.newsAvailable ? "news_z" : "volume_z",
  };
  const json = JSON.stringify(state);
  return { state, hash: createHash("sha256").update(json).digest("hex").slice(0, 16), approxTokens: Math.ceil(json.length / 3) };
}
