import { useEffect, useState } from "react";
import { money, pct, signed, tone } from "./format";
import { PROFILE, type PublicAgent, type Snapshot } from "./types";
import type { Window } from "./useFeed";

function Clock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="num">{new Date(now).toISOString().slice(11, 19)} UTC</span>;
}

function Recon({ recon, mode }: { recon: Snapshot["recon"] | undefined; mode: Snapshot["mode"] | undefined }) {
  const state = !recon || recon.ok === null ? "idle" : recon.ok ? "ok" : "bad";
  const text = state === "ok" ? "books match Coinbase" : state === "bad" ? recon!.detail : mode === "dry" ? "paper trading: simulated books" : "first check pending";
  return (
    <div className={`recon recon-${state}`} title={recon?.detail}>
      <span className="recon-light" aria-hidden />
      <div>
        <div className="eyebrow">Reconciliation</div>
        <div className="recon-text">
          {state === "ok" ? "✓ " : state === "bad" ? "✗ " : ""}
          {text}
        </div>
      </div>
    </div>
  );
}

function Counter({ label, value, sub, tone: t }: { label: string; value: string; sub?: string; tone?: "" | "good" | "bad" }) {
  return (
    <div className="counter">
      <div className="eyebrow">{label}</div>
      <div className={`counter-value num ${t ?? ""}`}>{value}</div>
      {sub && <div className="counter-sub num">{sub}</div>}
    </div>
  );
}

const WINDOWS: Array<[Window, string]> = [
  [1, "24h"],
  [7, "7d"],
  [30, "30d"],
  [90, "90d"],
  [365, "1y"],
];

interface Props {
  snap: Snapshot | null;
  agent: PublicAgent | null;
  connected: boolean;
  stalled: boolean;
  soundOn: boolean;
  onSound: () => void;
  days: Window;
  onDays: (d: Window) => void;
}

export function Header({ snap, agent, connected, stalled, soundOn, onSound, days, onDays }: Props) {
  const day = snap?.startedAt ? Math.floor((Date.now() - snap.startedAt) / 86_400_000) + 1 : 1;
  const jev = snap?.jev;
  const live = connected && !stalled;
  const a = agent;
  return (
    <header className="top">
      <div className="brand">
        <div className="brand-row">
          <div className="logo">profitbots</div>
          <span className={`mode mode-${snap?.mode ?? "dry"}`}>
            {snap?.mode === "live" ? "● LIVE MONEY" : "PAPER TRADING"}
            {snap?.closed ? (snap.closed.flat ? " · ENDED" : " · CLOSING") : ""}
          </span>
        </div>
        <div className="brand-sub">
          <span className="dim">
            day {day} · one agent · {PROFILE.venue} · up to {PROFILE.maxLeverage}x · Jev {PROFILE.jevModel || "decides"}
          </span>
          {snap?.update ? (
            <a className="update-pill" href={`${PROFILE.links?.code ?? "https://github.com/MatthewMastando/profitbots"}/releases/latest`} target="_blank" rel="noopener" title={`You run ${snap.update.current}.`}>
              Update available: {snap.update.latest} ↗
            </a>
          ) : null}
        </div>
      </div>

      <div className="counters">
        <Counter label="Equity" value={money(a?.equityUsd)} sub={a ? `cash ${money(a.cashUsd)} · open ${signed(a.uplUsd)}` : undefined} />
        <Counter label="Total P&L" value={signed(a?.pnlUsd)} tone={tone(a?.pnlUsd)} sub={a ? `${pct(a.pnlPct)} on ${money(snap?.startEquityUsd ?? PROFILE.startEquityUsd, 0)}` : undefined} />
        <Counter label="Today" value={signed(a?.dayPnlUsd)} tone={tone(a?.dayPnlUsd)} sub={a ? `${a.tradesToday}/${a.maxTradesPerDay} trades · fees ${money(a.feesTodayUsd)}` : undefined} />
        <Counter label="Drawdown" value={a ? `−${a.drawdownPct.toFixed(1)}%` : "–"} tone={a && a.drawdownPct > 5 ? "bad" : ""} sub={a ? `peak ${money(a.peakEquityUsd)}` : undefined} />
        <Counter
          label="Exposure"
          value={a ? money(a.grossNotionalUsd, 0) : "–"}
          sub={a ? `of ${money(a.maxNotionalUsd, 0)} · ${a.positions.length} open` : undefined}
        />
        <Counter
          label="Jev spend"
          value={a ? money(a.totals.jevUsd, 4) : "–"}
          sub={jev ? `today ${money(jev.spentTodayUsd, 3)} of ${money(jev.dailyCapUsd, 0)} cap` : undefined}
          tone={jev?.down || jev?.capTripped ? "bad" : ""}
        />
        <Counter label="Decisions" value={a ? a.totals.decisions.toLocaleString() : "–"} sub={jev?.down ? "Jev unreachable: holding" : jev?.capTripped ? "Jev cap hit: holding" : `${a?.totals.orders ?? 0} orders`} tone={jev?.down || jev?.capTripped ? "bad" : ""} />
      </div>

      <div className="top-right">
        <div className="windows" role="tablist" aria-label="Analytics window">
          {WINDOWS.map(([d, label]) => (
            <button key={d} role="tab" aria-selected={d === days} className={d === days ? "on" : ""} onClick={() => onDays(d)}>
              {label}
            </button>
          ))}
        </div>
        <Recon recon={snap?.recon} mode={snap?.mode} />
        <div className="conn">
          <span className={`conn-dot ${live ? "on" : "off"}`} />
          <span>{live ? "live" : connected ? "stalled" : "reconnecting"}</span>
          <Clock />
          <button className={`sound ${soundOn ? "on" : ""}`} onClick={onSound} aria-pressed={soundOn}>
            {soundOn ? "🔊" : "🔇"}
          </button>
        </div>
      </div>
    </header>
  );
}
