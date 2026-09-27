// SQLite (WAL) via node:sqlite. Every decision is written before it is acted on.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentState, Lens, Side } from "./agent/types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
  state_hash TEXT, state_json TEXT, menu_json TEXT,
  choice TEXT, probabilities_json TEXT, confidence REAL, conviction REAL,
  latency_ms INTEGER, input_tokens INTEGER, jev_cost_usd REAL NOT NULL DEFAULT 0, jev_error TEXT,
  action_json TEXT NOT NULL, vetoed_by TEXT, forced_by TEXT, status TEXT
);
CREATE INDEX IF NOT EXISTS decisions_ts ON decisions(ts);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, decision_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  cl_ord_id TEXT NOT NULL UNIQUE, ord_id TEXT, inst_id TEXT NOT NULL, side TEXT NOT NULL,
  contracts REAL NOT NULL, reduce_only INTEGER NOT NULL, purpose TEXT NOT NULL,
  state TEXT NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS fills (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL, ts INTEGER NOT NULL,
  inst_id TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL, contracts REAL NOT NULL, px REAL NOT NULL,
  notional_usd REAL NOT NULL, fee_usd REAL NOT NULL, realised_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS fills_ts ON fills(ts);
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY, opened_ts INTEGER NOT NULL, closed_ts INTEGER NOT NULL,
  inst_id TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL, lens TEXT NOT NULL,
  contracts REAL NOT NULL, entry_px REAL NOT NULL, exit_px REAL NOT NULL, notional_usd REAL NOT NULL,
  pnl_usd REAL NOT NULL, fee_usd REAL NOT NULL, reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trades_closed ON trades(closed_ts);
CREATE TABLE IF NOT EXISTS funding (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, inst_id TEXT,
  amount_usd REAL NOT NULL, bill_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS equity_snapshots (ts INTEGER NOT NULL, equity_usd REAL, cash_usd REAL, upl_usd REAL);
CREATE INDEX IF NOT EXISTS equity_ts ON equity_snapshots(ts);
CREATE TABLE IF NOT EXISTS reconciliations (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, ok INTEGER NOT NULL, diff_json TEXT);
CREATE TABLE IF NOT EXISTS caps (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, cap TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS agent_state (id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

export interface DecisionRow {
  ts: number;
  stateHash: string | null;
  stateJson: string | null;
  menuJson: string | null;
  choice: string | null;
  probabilities: Record<string, number> | null;
  confidence: number | null;
  conviction: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  jevCostUsd: number;
  jevError: string | null;
  action: unknown;
  vetoedBy: string | null;
  forcedBy: string | null;
  status: string;
}

export interface OrderRow {
  decisionId: number;
  ts: number;
  clOrdId: string;
  instId: string;
  side: "buy" | "sell";
  contracts: number;
  reduceOnly: boolean;
  purpose: string;
}

export interface FillRow {
  orderId: number;
  ts: number;
  instId: string;
  coin: string;
  side: "buy" | "sell";
  contracts: number;
  px: number;
  notionalUsd: number;
  feeUsd: number;
  realisedUsd: number;
}

/** A closed round trip. `pnlUsd` is net of fees. */
export interface TradeRow {
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

export interface TradeOut extends TradeRow {
  id: number;
}

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.raw.exec(SCHEMA);
  }

  insertDecision(d: DecisionRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO decisions (ts, state_hash, state_json, menu_json, choice, probabilities_json, confidence, conviction,
          latency_ms, input_tokens, jev_cost_usd, jev_error, action_json, vetoed_by, forced_by, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.ts, d.stateHash, d.stateJson, d.menuJson, d.choice, d.probabilities ? JSON.stringify(d.probabilities) : null,
        d.confidence, d.conviction, d.latencyMs, d.inputTokens, d.jevCostUsd, d.jevError, JSON.stringify(d.action),
        d.vetoedBy, d.forcedBy, d.status,
      );
    return Number(r.lastInsertRowid);
  }

  insertOrder(o: OrderRow): number {
    const r = this.raw
      .prepare(
        `INSERT INTO orders (decision_id, ts, cl_ord_id, inst_id, side, contracts, reduce_only, purpose, state)
         VALUES (?,?,?,?,?,?,?,?,'sent')`,
      )
      .run(o.decisionId, o.ts, o.clOrdId, o.instId, o.side, o.contracts, o.reduceOnly ? 1 : 0, o.purpose);
    return Number(r.lastInsertRowid);
  }

  updateOrder(id: number, state: string, ordId: string | null, error: string | null): void {
    this.raw.prepare(`UPDATE orders SET state = ?, ord_id = COALESCE(?, ord_id), error = ? WHERE id = ?`).run(state, ordId, error, id);
  }

  insertFill(f: FillRow): void {
    this.raw
      .prepare(`INSERT INTO fills (order_id, ts, inst_id, coin, side, contracts, px, notional_usd, fee_usd, realised_usd) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(f.orderId, f.ts, f.instId, f.coin, f.side, f.contracts, f.px, f.notionalUsd, f.feeUsd, f.realisedUsd);
  }

  insertTrade(t: TradeRow): void {
    this.raw
      .prepare(
        `INSERT INTO trades (opened_ts, closed_ts, inst_id, coin, side, lens, contracts, entry_px, exit_px, notional_usd, pnl_usd, fee_usd, reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(t.openedTs, t.closedTs, t.instId, t.coin, t.side, t.lens, t.contracts, t.entryPx, t.exitPx, t.notionalUsd, t.pnlUsd, t.feeUsd, t.reason);
  }

  trades(sinceTs: number, limit: number): TradeOut[] {
    const rows = this.raw
      .prepare(
        `SELECT id, opened_ts AS openedTs, closed_ts AS closedTs, inst_id AS instId, coin, side, lens, contracts, entry_px AS entryPx, exit_px AS exitPx,
           notional_usd AS notionalUsd, pnl_usd AS pnlUsd, fee_usd AS feeUsd, reason
         FROM trades WHERE closed_ts >= ? ORDER BY closed_ts DESC LIMIT ?`,
      )
      .all(sinceTs, limit) as unknown as TradeOut[];
    return rows;
  }

  /** Last filled opening order (dry-run resume). */
  lastOpenOrder(): { instId: string; side: "buy" | "sell"; contracts: number } | null {
    const r = this.raw.prepare(`SELECT inst_id AS instId, side, contracts FROM orders WHERE reduce_only = 0 AND state = 'filled' ORDER BY id DESC LIMIT 1`).get() as
      | { instId: string; side: "buy" | "sell"; contracts: number }
      | undefined;
    return r ?? null;
  }

  /** Recent filled orders that have a venue order id, with our recorded fee (reconciliation). */
  recentVenueOrders(limit: number): Array<{ ordId: string; instId: string; fee: number }> {
    return this.raw
      .prepare(`SELECT o.ord_id AS ordId, o.inst_id AS instId, f.fee_usd AS fee FROM orders o JOIN fills f ON f.order_id = o.id WHERE o.ord_id IS NOT NULL ORDER BY o.id DESC LIMIT ?`)
      .all(limit) as Array<{ ordId: string; instId: string; fee: number }>;
  }

  /** Returns false if this bill was already recorded. */
  insertFunding(ts: number, instId: string | null, amountUsd: number, billId: string): boolean {
    const r = this.raw.prepare(`INSERT OR IGNORE INTO funding (ts, inst_id, amount_usd, bill_id) VALUES (?,?,?,?)`).run(ts, instId, amountUsd, billId);
    return Number(r.changes) > 0;
  }

  insertEquity(ts: number, equity: number, cash: number, upl: number): void {
    this.raw.prepare(`INSERT INTO equity_snapshots (ts, equity_usd, cash_usd, upl_usd) VALUES (?,?,?,?)`).run(ts, equity, cash, upl);
  }

  /** Equity, bucketed to at most ~`points` samples (last value in each bucket). */
  equitySeries(sinceTs: number, points: number, now = Date.now()): Array<[number, number]> {
    const span = Math.max(1, now - sinceTs);
    const bucket = Math.max(10_000, Math.ceil(span / points));
    const rows = this.raw
      .prepare(`SELECT MAX(ts) AS ts, equity_usd AS eq FROM equity_snapshots WHERE ts >= ? GROUP BY ts / ? ORDER BY ts`)
      .all(sinceTs, bucket) as Array<{ ts: number; eq: number }>;
    return rows.map((r) => [r.ts, Number(r.eq.toFixed(2))]);
  }

  /** Last equity of each UTC day. */
  dailyEquity(sinceTs: number): Array<{ day: string; equityUsd: number }> {
    const rows = this.raw
      .prepare(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch') AS day, MAX(ts) AS ts, equity_usd AS eq FROM equity_snapshots WHERE ts >= ? GROUP BY day ORDER BY day`)
      .all(sinceTs) as Array<{ day: string; ts: number; eq: number }>;
    return rows.map((r) => ({ day: r.day, equityUsd: Number(r.eq.toFixed(2)) }));
  }

  /** Equity just before `sinceTs` (baseline for a window). */
  equityBefore(ts: number): number | null {
    const r = this.raw.prepare(`SELECT equity_usd AS eq FROM equity_snapshots WHERE ts < ? ORDER BY ts DESC LIMIT 1`).get(ts) as { eq: number } | undefined;
    return r?.eq ?? null;
  }

  costsSince(sinceTs: number): { feesUsd: number; fundingUsd: number; jevUsd: number } {
    const f = this.raw.prepare(`SELECT COALESCE(SUM(fee_usd), 0) AS s FROM fills WHERE ts >= ?`).get(sinceTs) as { s: number };
    const fu = this.raw.prepare(`SELECT COALESCE(SUM(amount_usd), 0) AS s FROM funding WHERE ts >= ?`).get(sinceTs) as { s: number };
    const j = this.raw.prepare(`SELECT COALESCE(SUM(jev_cost_usd), 0) AS s FROM decisions WHERE ts >= ?`).get(sinceTs) as { s: number };
    return { feesUsd: f.s, fundingUsd: fu.s, jevUsd: j.s };
  }

  jevStats(sinceTs: number): { decisions: number; asked: number; errors: number; avgLatencyMs: number | null; inputTokens: number; choices: Array<{ label: string; n: number }>; vetoes: Array<{ reason: string; n: number }>; forced: Array<{ reason: string; n: number }> } {
    const t = this.raw
      .prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN latency_ms IS NOT NULL AND latency_ms > 0 THEN 1 ELSE 0 END) AS asked, SUM(CASE WHEN jev_error IS NOT NULL THEN 1 ELSE 0 END) AS errors, AVG(CASE WHEN latency_ms > 0 THEN latency_ms END) AS lat, COALESCE(SUM(input_tokens), 0) AS tok FROM decisions WHERE ts >= ?`)
      .get(sinceTs) as { n: number; asked: number | null; errors: number | null; lat: number | null; tok: number };
    const choices = this.raw.prepare(`SELECT choice AS label, COUNT(*) AS n FROM decisions WHERE ts >= ? AND choice IS NOT NULL GROUP BY choice ORDER BY n DESC LIMIT 12`).all(sinceTs) as Array<{ label: string; n: number }>;
    const vetoes = this.raw.prepare(`SELECT vetoed_by AS reason, COUNT(*) AS n FROM decisions WHERE ts >= ? AND vetoed_by IS NOT NULL GROUP BY vetoed_by ORDER BY n DESC LIMIT 12`).all(sinceTs) as Array<{ reason: string; n: number }>;
    const forced = this.raw.prepare(`SELECT forced_by AS reason, COUNT(*) AS n FROM decisions WHERE ts >= ? AND forced_by IS NOT NULL GROUP BY forced_by ORDER BY n DESC LIMIT 12`).all(sinceTs) as Array<{ reason: string; n: number }>;
    return {
      decisions: t.n,
      asked: t.asked ?? 0,
      errors: t.errors ?? 0,
      avgLatencyMs: t.lat === null ? null : Math.round(t.lat),
      inputTokens: t.tok,
      choices: choices.map((c) => ({ label: c.label.replace(/_[A-Z0-9]+$/, (m) => m), n: c.n })),
      vetoes: vetoes.map((v) => ({ reason: v.reason.split(" ")[0]!, n: v.n })),
      forced,
    };
  }

  insertRecon(ts: number, ok: boolean, diff: unknown): void {
    this.raw.prepare(`INSERT INTO reconciliations (ts, ok, diff_json) VALUES (?,?,?)`).run(ts, ok ? 1 : 0, JSON.stringify(diff));
  }

  insertCap(ts: number, cap: string, detail: string): void {
    this.raw.prepare(`INSERT INTO caps (ts, cap, detail) VALUES (?,?,?)`).run(ts, cap, detail);
  }

  saveAgent(s: AgentState, ts: number): void {
    this.raw.prepare(`INSERT INTO agent_state (id, json, updated_ts) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ts = excluded.updated_ts`).run(s.id, JSON.stringify(s), ts);
  }

  loadAgent(): AgentState | null {
    const row = this.raw.prepare(`SELECT json FROM agent_state WHERE id = 'agent'`).get() as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as AgentState) : null;
  }

  insertEvent(ts: number, type: string, json: string): void {
    this.raw.prepare(`INSERT INTO events (ts, type, json) VALUES (?,?,?)`).run(ts, type, json);
  }

  recentEvents(n: number): string[] {
    const rows = this.raw.prepare(`SELECT json FROM (SELECT id, json FROM events ORDER BY id DESC LIMIT ?) ORDER BY id ASC`).all(n) as Array<{ json: string }>;
    return rows.map((r) => r.json);
  }

  pruneEvents(olderThanTs: number): void {
    this.raw.prepare(`DELETE FROM events WHERE ts < ?`).run(olderThanTs);
  }

  jevSpendSince(ts: number): number {
    const r = this.raw.prepare(`SELECT COALESCE(SUM(jev_cost_usd), 0) AS s FROM decisions WHERE ts >= ?`).get(ts) as { s: number };
    return r.s;
  }

  getMeta(k: string): string | null {
    const r = this.raw.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.raw.prepare(`INSERT INTO meta (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(k, v);
  }

  close(): void {
    this.raw.close();
  }
}
