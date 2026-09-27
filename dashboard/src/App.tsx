import { useEffect, useState } from "react";
import { EquityChart } from "./EquityChart";
import { Header } from "./Header";
import { BreakdownTable, Card, DailyBars, JevPanel, Positions, Stats, Trades } from "./Panels";
import { unlockAudio } from "./sound";
import { Ticker } from "./Ticker";
import { Toasts } from "./Toasts";
import { PROFILE } from "./types";
import { useFeed, type Window } from "./useFeed";

const WINDOW_LABEL: Record<Window, string> = { 1: "24h", 7: "7 days", 30: "30 days", 90: "90 days", 365: "1 year" };

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: fine */
  }
}

export function App() {
  const [soundOn, setSoundOn] = useState(false);
  const [days, setDays] = useState<Window>(() => (Number(readPref("agent.window", "30")) as Window) || 30);
  const feed = useFeed(soundOn, days);
  const [, force] = useState(0);

  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (readPref<string>("agent.sound", "off") !== "on") return;
    const once = () => setSoundOn(unlockAudio());
    window.addEventListener("pointerdown", once, { once: true });
    return () => window.removeEventListener("pointerdown", once);
  }, []);

  const toggleSound = () => {
    const next = !soundOn && unlockAudio();
    setSoundOn(next);
    writePref("agent.sound", next ? "on" : "off");
  };
  const pickDays = (d: Window) => {
    setDays(d);
    writePref("agent.window", String(d));
  };

  const stalled = feed.lastEventAt > 0 && Date.now() - feed.lastEventAt > 15_000;
  const baseline = feed.snap?.startEquityUsd ?? PROFILE.startEquityUsd;
  const blocked = feed.snap?.market.spreadBlocked ?? [];
  const flash = feed.flash;

  return (
    <div className={`app ${flash ? `flash-${flash.kind}` : ""}`}>
      <Header snap={feed.snap} agent={feed.agent} connected={feed.connected} stalled={stalled} soundOn={soundOn} onSound={toggleSound} days={days} onDays={pickDays} />
      <main className="layout">
        <div className="col main-col">
          <Card title={`Equity · ${WINDOW_LABEL[days]}`} right={flash ? flash.text : feed.agent?.last?.status} className="equity">
            <EquityChart curve={feed.curve} color="var(--accent)" baseline={baseline} gradientId="eq" />
          </Card>
          <Positions a={feed.agent} />
          <Stats a={feed.analytics} label={WINDOW_LABEL[days]} />
          <div className="row2">
            <DailyBars daily={feed.analytics?.daily ?? []} />
            <JevPanel a={feed.analytics} />
          </div>
          <div className="row4">
            <BreakdownTable title="By coin" keyLabel="coin" rows={feed.analytics?.byCoin ?? []} />
            <BreakdownTable title="By side" keyLabel="side" rows={feed.analytics?.bySide ?? []} />
            <BreakdownTable title="By lens" keyLabel="lens" rows={feed.analytics?.byLens ?? []} />
            <BreakdownTable title="By exit" keyLabel="exit" rows={feed.analytics?.byReason ?? []} />
          </div>
          <Trades trades={feed.trades} />
        </div>
        <aside className="col rail">
          <Ticker decisions={feed.decisions} perMin={feed.decisionTimes.length} />
          {feed.snap && (
            <Card title="Universe" right={`${feed.snap.market.universe.length} tradable`}>
              <div className="chips num">
                {feed.snap.market.universe.slice(0, 30).map((c) => (
                  <span key={c}>{c}</span>
                ))}
              </div>
              {blocked.length > 0 && (
                <div className="chips blocked num">
                  {blocked.slice(0, 8).map((b) => (
                    <span key={b.coin} title="spread gate">
                      {b.coin} <span className="dim">{b.spreadBp}bp</span>
                    </span>
                  ))}
                </div>
              )}
            </Card>
          )}
        </aside>
      </main>
      <Toasts toasts={feed.toasts} />
    </div>
  );
}
