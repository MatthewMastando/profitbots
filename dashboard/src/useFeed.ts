import { useEffect, useReducer, useRef } from "react";
import { playOrder } from "./sound";
import type { Analytics, AnyEvent, CapEvent, DecisionEvent, EquityEvent, FillEvent, FundingEvent, PublicAgent, Snapshot, Trade, TradeEvent } from "./types";

const MAX_DECISIONS = 60;
const MAX_POINTS = 1500;
const CURVE_STEP_MS = 10_000;

export type Curve = Array<[number, number]>;
export type Window = 1 | 7 | 30 | 90 | 365;

export interface Toast extends FillEvent {
  id: number;
}

export interface FeedState {
  snap: Snapshot | null;
  agent: PublicAgent | null;
  curve: Curve;
  analytics: Analytics | null;
  trades: Trade[];
  decisions: DecisionEvent[];
  toasts: Toast[];
  flash: { kind: "fill" | "funding" | "cap"; at: number; text: string } | null;
  connected: boolean;
  lastEventAt: number;
  decisionTimes: number[];
}

type Action =
  | { t: "snap"; snap: Snapshot }
  | { t: "curve"; curve: Curve }
  | { t: "analytics"; analytics: Analytics }
  | { t: "trades"; trades: Trade[] }
  | { t: "history"; events: AnyEvent[] }
  | { t: "event"; ev: AnyEvent }
  | { t: "connected"; on: boolean }
  | { t: "expire"; now: number };

let toastId = 0;

function appendPoint(curve: Curve, ts: number, eq: number): Curve {
  const c = [...curve];
  const last = c[c.length - 1];
  if (last && ts - last[0] < CURVE_STEP_MS && c.length > 1) c[c.length - 1] = [ts, eq];
  else c.push([ts, eq]);
  if (c.length > MAX_POINTS) return c.filter((_, i) => i % 2 === 0 || i === c.length - 1);
  return c;
}

function reduce(s: FeedState, a: Action): FeedState {
  switch (a.t) {
    case "snap":
      return { ...s, snap: a.snap, agent: a.snap.agent };
    case "curve":
      return { ...s, curve: a.curve };
    case "analytics":
      return { ...s, analytics: a.analytics };
    case "trades":
      return { ...s, trades: a.trades };
    case "history":
      return { ...s, decisions: a.events.filter((e): e is DecisionEvent => e.type === "decision").reverse().slice(0, MAX_DECISIONS) };
    case "connected":
      return { ...s, connected: a.on };
    case "expire": {
      const toasts = s.toasts.filter((t) => a.now - t.id < 7000);
      const decisionTimes = s.decisionTimes.filter((t) => a.now - t < 60_000);
      const flash = s.flash && a.now - s.flash.at > 4000 ? null : s.flash;
      return toasts.length === s.toasts.length && decisionTimes.length === s.decisionTimes.length && flash === s.flash ? s : { ...s, toasts, decisionTimes, flash };
    }
    case "event": {
      const ev = a.ev;
      const now = Date.now();
      const base = { ...s, lastEventAt: now };
      switch (ev.type) {
        case "decision":
          return { ...base, decisions: [ev as DecisionEvent, ...s.decisions].slice(0, MAX_DECISIONS), decisionTimes: [...s.decisionTimes, now] };
        case "equity": {
          const e = ev as EquityEvent;
          return { ...base, agent: e, curve: appendPoint(s.curve, e.ts, e.equityUsd) };
        }
        case "fill": {
          const f = ev as FillEvent;
          toastId = Math.max(toastId + 1, now);
          return { ...base, toasts: [...s.toasts, { ...f, id: toastId }].slice(-3), flash: { kind: "fill", at: now, text: f.label } };
        }
        case "trade": {
          const t = ev as TradeEvent;
          // Optimistic row until the next /trades poll returns the persisted one.
          const row: Trade = { id: -t.ts, openedTs: t.ts - t.minutesHeld * 60_000, closedTs: t.ts, instId: "", coin: t.coin, side: t.side, lens: t.lens, contracts: 0, entryPx: 0, exitPx: 0, notionalUsd: 0, pnlUsd: t.pnlUsd, feeUsd: 0, reason: t.reason };
          return { ...base, trades: [row, ...s.trades].slice(0, 200) };
        }
        case "funding": {
          const f = ev as FundingEvent;
          return { ...base, flash: { kind: "funding", at: now, text: `funding ${f.coin ?? ""} ${f.amountUsd >= 0 ? "+" : "−"}$${Math.abs(f.amountUsd).toFixed(4)}` } };
        }
        case "cap":
          return { ...base, flash: { kind: "cap", at: now, text: (ev as CapEvent).detail } };
        case "recon":
          return s.snap ? { ...base, snap: { ...s.snap, recon: { ok: ev.ok as boolean, detail: ev.detail as string, ts: ev.ts } } } : base;
        default:
          return base;
      }
    }
  }
}

const initial: FeedState = { snap: null, agent: null, curve: [], analytics: null, trades: [], decisions: [], toasts: [], flash: null, connected: false, lastEventAt: 0, decisionTimes: [] };

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return (await r.json()) as T;
}

export function useFeed(soundOn: boolean, days: Window): FeedState {
  const [state, dispatch] = useReducer(reduce, initial);
  const sound = useRef(soundOn);
  sound.current = soundOn;

  // Window-scoped data: equity curve, analytics, trade log.
  useEffect(() => {
    let alive = true;
    const load = () => {
      getJson<Curve>(`/equity?days=${days}`).then((curve) => alive && dispatch({ t: "curve", curve })).catch(() => {});
      getJson<Analytics>(`/analytics?days=${days}`).then((analytics) => alive && dispatch({ t: "analytics", analytics })).catch(() => {});
      getJson<Trade[]>(`/trades?days=${days}&n=200`).then((trades) => alive && dispatch({ t: "trades", trades })).catch(() => {});
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [days]);

  useEffect(() => {
    let alive = true;
    const loadSnap = () => getJson<Snapshot>("/snapshot").then((snap) => alive && dispatch({ t: "snap", snap })).catch(() => {});
    void loadSnap();
    getJson<AnyEvent[]>("/history?n=400").then((events) => alive && dispatch({ t: "history", events })).catch(() => {});

    const es = new EventSource("/events");
    es.onopen = () => {
      dispatch({ t: "connected", on: true });
      void loadSnap();
    };
    es.onerror = () => dispatch({ t: "connected", on: false });
    es.onmessage = (m) => {
      let ev: AnyEvent;
      try {
        ev = JSON.parse(m.data) as AnyEvent;
      } catch {
        return;
      }
      dispatch({ t: "event", ev });
      if (ev.type === "fill" && sound.current) {
        const f = ev as FillEvent;
        const closing = f.purpose !== "open" && f.purpose !== "add";
        playOrder(!closing ? "open" : f.realisedUsd - f.feeUsd >= 0 ? "win" : "loss");
      }
    };

    const snapTimer = setInterval(loadSnap, 5000);
    const expireTimer = setInterval(() => dispatch({ t: "expire", now: Date.now() }), 500);
    return () => {
      alive = false;
      es.close();
      clearInterval(snapTimer);
      clearInterval(expireTimer);
    };
  }, []);

  return state;
}
