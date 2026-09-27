// Analytics panels: stat grid, daily P&L bars, breakdown tables, open positions, trade log.
import { duration, lens, money, pct, px, ratio, reason, signed, tone, when } from "./format";
import type { Analytics, Breakdown, PublicAgent, PublicPosition, Trade } from "./types";

export function Card({ title, right, children, className = "" }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      <div className="card-head">
        <span className="eyebrow">{title}</span>
        {right && <span className="dim num">{right}</span>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: "" | "good" | "bad" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${t ?? ""}`}>{value}</div>
      {sub && <div className="stat-sub num">{sub}</div>}
    </div>
  );
}

export function Stats({ a, label }: { a: Analytics | null; label: string }) {
  const t = a?.trades;
  const e = a?.equity;
  return (
    <Card title={`Performance · ${label}`} right={t ? `${t.count} closed trades` : "loading…"}>
      <div className="stats">
        <Stat label="Net P&L" value={signed(e?.pnlUsd)} tone={tone(e?.pnlUsd)} sub={pct(e?.pnlPct)} />
        <Stat label="Max drawdown" value={e?.maxDrawdownPct === null || e?.maxDrawdownPct === undefined ? "–" : `−${e.maxDrawdownPct.toFixed(2)}%`} tone={e && (e.maxDrawdownPct ?? 0) > 5 ? "bad" : ""} sub={e?.maxDrawdownUsd === null || e?.maxDrawdownUsd === undefined ? undefined : `−${money(e.maxDrawdownUsd)}`} />
        <Stat label="Win rate" value={t?.winRate === null || t?.winRate === undefined ? "–" : `${t.winRate.toFixed(0)}%`} sub={t ? `${t.wins}W · ${t.losses}L` : undefined} />
        <Stat label="Profit factor" value={ratio(t?.profitFactor)} tone={t?.profitFactor === null || t?.profitFactor === undefined ? "" : t.profitFactor >= 1 ? "good" : "bad"} sub="gross win ÷ gross loss" />
        <Stat label="Expectancy" value={signed(t?.expectancyUsd)} tone={tone(t?.expectancyUsd)} sub="per trade, after fees" />
        <Stat label="Sharpe" value={ratio(a?.sharpe, 2)} tone={a?.sharpe === null || a?.sharpe === undefined ? "" : a.sharpe >= 1 ? "good" : a.sharpe < 0 ? "bad" : ""} sub="annualised, daily" />
        <Stat label="Avg win / loss" value={t ? `${signed(t.avgWinUsd)} / ${signed(t.avgLossUsd)}` : "–"} sub={t ? `best ${signed(t.bestUsd)} · worst ${signed(t.worstUsd)}` : undefined} />
        <Stat label="Avg hold" value={duration(t?.avgHoldMinutes)} />
        <Stat label="Costs" value={a ? money(a.costs.totalUsd) : "–"} tone={a && a.costs.totalUsd > 0 ? "bad" : ""} sub={a ? `fees ${money(a.costs.feesUsd)} · funding ${signed(a.costs.fundingUsd)} · Jev ${money(a.costs.jevUsd, 3)}` : undefined} />
      </div>
    </Card>
  );
}

export function DailyBars({ daily }: { daily: Analytics["daily"] }) {
  const rows = daily.slice(-60);
  const max = Math.max(1e-9, ...rows.map((d) => Math.abs(d.pnlUsd)));
  return (
    <Card title="Daily P&L" right={rows.length ? `${rows.filter((d) => d.pnlUsd > 0).length} green of ${rows.length} days` : undefined}>
      {rows.length === 0 ? (
        <div className="empty">no full days yet</div>
      ) : (
        <div className="bars" role="img" aria-label="Daily P&L bars">
          {rows.map((d) => {
            const h = (Math.abs(d.pnlUsd) / max) * 50;
            return (
              <div key={d.day} className="bar-col" title={`${d.day}: ${signed(d.pnlUsd)} → ${money(d.equityUsd)}`}>
                <div className="bar-up">{d.pnlUsd > 0 && <span className="bar good" style={{ height: `${h}%` }} />}</div>
                <div className="bar-dn">{d.pnlUsd < 0 && <span className="bar bad" style={{ height: `${h}%` }} />}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function BreakdownTable({ title, rows, keyLabel }: { title: string; rows: Breakdown[]; keyLabel: string }) {
  const sorted = [...rows].sort((a, b) => b.pnlUsd - a.pnlUsd);
  const max = Math.max(1e-9, ...sorted.map((r) => Math.abs(r.pnlUsd)));
  return (
    <Card title={title}>
      {sorted.length === 0 ? (
        <div className="empty">no closed trades</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>{keyLabel}</th>
              <th className="r">trades</th>
              <th className="r">win</th>
              <th className="r">P&L</th>
              <th className="w"></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.key}>
                <td className="k">{keyLabel === "lens" ? lens(r.key) : reason(r.key)}</td>
                <td className="r num">{r.trades}</td>
                <td className="r num">{r.winRate === null ? "–" : `${r.winRate.toFixed(0)}%`}</td>
                <td className={`r num ${tone(r.pnlUsd)}`}>{signed(r.pnlUsd)}</td>
                <td className="w">
                  <span className={`hbar ${tone(r.pnlUsd)}`} style={{ width: `${(Math.abs(r.pnlUsd) / max) * 100}%` }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PositionRow({ p }: { p: PublicPosition }) {
  return (
    <tr>
      <td className="k">
        <span className={`side ${p.side}`}>{p.side === "long" ? "▲ LONG" : "▼ SHORT"}</span> <span className="pos-coin">{p.coin}</span> <span className="dim">{lens(p.lens)}</span>
      </td>
      <td className="r num">{money(p.sizeUsd, 0)}</td>
      <td className="r num">{px(p.entryPx)}</td>
      <td className="r num">{px(p.markPx)}</td>
      <td className="r num">{px(p.stopPx)}</td>
      <td className={`r num ${tone(p.uplUsd)}`}>
        {signed(p.uplUsd)} {p.uplR !== null && <span className="dim">{p.uplR >= 0 ? "+" : ""}{p.uplR.toFixed(1)}R</span>}
      </td>
      <td className="r num dim">{duration(p.minutesHeld)}</td>
    </tr>
  );
}

export function Positions({ a }: { a: PublicAgent | null }) {
  const ps = a?.positions ?? [];
  return (
    <Card title="Open positions" right={a ? (ps.length ? `${money(a.grossNotionalUsd, 0)} of ${money(a.maxNotionalUsd, 0)} deployed` : a.flatMinutes !== null ? `flat for ${duration(a.flatMinutes)}` : undefined) : undefined}>
      {ps.length === 0 ? (
        <div className="empty">{a?.last?.status ?? "flat"}</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>position</th>
              <th className="r">notional</th>
              <th className="r">entry</th>
              <th className="r">mark</th>
              <th className="r">stop</th>
              <th className="r">open P&L</th>
              <th className="r">held</th>
            </tr>
          </thead>
          <tbody>
            {ps.map((p) => (
              <PositionRow key={p.instId} p={p} />
            ))}
          </tbody>
        </table>
      )}
      {a?.cap && <div className="cap-note">⛔ {a.cap.replace(/_/g, " ")}: {a.last?.status}</div>}
    </Card>
  );
}

export function Trades({ trades }: { trades: Trade[] }) {
  return (
    <Card title="Trade log" right={trades.length ? `${trades.length} most recent` : undefined} className="trades">
      {trades.length === 0 ? (
        <div className="empty">no closed trades in this window</div>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th>closed</th>
              <th>trade</th>
              <th className="r">size</th>
              <th className="r">entry → exit</th>
              <th className="r">held</th>
              <th>exit</th>
              <th className="r">fees</th>
              <th className="r">net P&L</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.id}>
                <td className="num dim">{when(t.closedTs)}</td>
                <td className="k">
                  <span className={`side ${t.side}`}>{t.side === "long" ? "▲" : "▼"}</span> <span className="pos-coin">{t.coin}</span> <span className="dim">{lens(t.lens)}</span>
                </td>
                <td className="r num">{t.notionalUsd ? money(t.notionalUsd, 0) : "–"}</td>
                <td className="r num">{t.entryPx ? `${px(t.entryPx)} → ${px(t.exitPx)}` : "–"}</td>
                <td className="r num dim">{duration((t.closedTs - t.openedTs) / 60_000)}</td>
                <td className="dim">{reason(t.reason)}</td>
                <td className="r num dim">{money(t.feeUsd)}</td>
                <td className={`r num ${tone(t.pnlUsd)}`}>{signed(t.pnlUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

export function JevPanel({ a }: { a: Analytics | null }) {
  const j = a?.jev;
  const top = (j?.choices ?? []).slice(0, 6);
  const max = Math.max(1, ...top.map((c) => c.n));
  return (
    <Card title="Jev decisions" right={j ? `${j.asked} asked · ${j.errors} errors · ${j.avgLatencyMs === null ? "–" : `${Math.round(j.avgLatencyMs)}ms`}` : undefined}>
      {top.length === 0 ? (
        <div className="empty">no decisions in this window</div>
      ) : (
        <div className="choices">
          {top.map((c) => (
            <div key={c.label} className="choice">
              <span className="choice-label">{c.label}</span>
              <span className="choice-bar">
                <span style={{ width: `${(c.n / max) * 100}%` }} />
              </span>
              <span className="num dim">{c.n}</span>
            </div>
          ))}
        </div>
      )}
      {j && (j.vetoes.length > 0 || j.forced.length > 0) && (
        <div className="jev-notes num">
          {j.vetoes.slice(0, 4).map((v) => (
            <span key={v.reason} className="veto">
              ✋ {v.reason.split(" ")[0]} ×{v.n}
            </span>
          ))}
          {j.forced.slice(0, 3).map((f) => (
            <span key={f.reason} className="forced">
              ⚡ {f.reason} ×{f.n}
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
