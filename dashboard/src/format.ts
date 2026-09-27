export const money = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "–" : `$${x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const signed = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`);
export const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "–" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(d)}%`);
export const ratio = (x: number | null | undefined, d = 2) => (x === null || x === undefined ? "–" : x.toFixed(d));
export const px = (x: number | null | undefined) => (x === null || x === undefined ? "–" : x >= 1000 ? x.toLocaleString(undefined, { maximumFractionDigits: 1 }) : x >= 1 ? x.toFixed(3) : x.toPrecision(4));
export const tone = (x: number | null | undefined): "" | "good" | "bad" => (x === null || x === undefined || x === 0 ? "" : x > 0 ? "good" : "bad");

export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "–";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

export const when = (ts: number) => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export const REASON: Record<string, string> = {
  open: "opened",
  add: "added",
  jev_close: "Jev closed",
  take_profit: "took profit",
  stop: "stopped out",
  time_stop: "time stop",
  trim: "trimmed",
  flip: "flipped",
  flip_close: "closed to flip",
  loss_stop: "daily loss stop",
  retired: "retired",
  wind_down: "wind-down",
};
export const reason = (r: string) => REASON[r] ?? r.replace(/_/g, " ");

export const LENS: Record<string, string> = { ict: "ICT", vprofile: "volume profile" };
export const lens = (l: string) => LENS[l] ?? l;
