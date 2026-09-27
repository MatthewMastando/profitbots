// Read-only HTTP for the dashboard: GET /events (SSE), /snapshot, /history?n=, /equity?days=, /analytics?days=,
// /trades?days=&n=, /health, /profile. Never config or keys (every body goes through redact()).
import { createServer, type Server, type ServerResponse } from "node:http";
import { computeAnalytics } from "./analytics.js";
import type { Db } from "./db.js";
import type { EventBus } from "./events.js";
import { log } from "./log.js";
import { redact } from "./redact.js";

export interface ServerDeps {
  bus: EventBus;
  db: Db;
  snapshot: () => unknown;
  health: () => { ok: boolean; [k: string]: unknown };
  /** Static facts about this install (mode, venue, leverage, links). No secrets. */
  profile: () => unknown;
  /** "Update available" (update.ts): null unless a newer GitHub Release exists. */
  update?: () => unknown;
  now?: () => number;
}

const MAX_BUFFERED = 1024 * 1024;
const MAX_STREAMS = 200;
const MAX_STREAMS_PER_ADDR = 10;
const MAX_HISTORY = 1000;
const HISTORY_CACHE_MS = 2000;
const ANALYTICS_CACHE_MS = 5000;

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(redact(body));
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
  res.end(s);
}

function days(url: URL, dflt: number, max: number): number {
  return Math.max(0.01, Math.min(max, Number(url.searchParams.get("days") ?? dflt) || dflt));
}

export function startServer(deps: ServerDeps, port: number, bind: string): Server {
  const now = deps.now ?? Date.now;
  const streams = new Map<string, number>();
  let streamsTotal = 0;
  const historyCache = new Map<number, { at: number; body: string }>();
  const analyticsCache = new Map<number, { at: number; body: unknown }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET") return json(res, 405, { error: "read-only" });
    const e = deps;

    switch (url.pathname) {
      case "/profile":
        return json(res, 200, deps.profile());
      case "/health": {
        const h = e.health();
        return json(res, h.ok ? 200 : 503, h);
      }
      case "/snapshot":
        return json(res, 200, { ...(e.snapshot() as object), watching: e.bus.subscribers, update: e.update?.() ?? null });
      case "/equity": {
        const d = days(url, 30, 365);
        return json(res, 200, e.db.equitySeries(now() - d * 86_400_000, 720, now()));
      }
      case "/analytics": {
        const d = days(url, 30, 365);
        let hit = analyticsCache.get(d);
        if (!hit || now() - hit.at > ANALYTICS_CACHE_MS) {
          if (analyticsCache.size > 20) analyticsCache.clear();
          hit = { at: now(), body: computeAnalytics(e.db, now() - d * 86_400_000, now()) };
          analyticsCache.set(d, hit);
        }
        return json(res, 200, hit.body);
      }
      case "/trades": {
        const d = days(url, 30, 365);
        const n = Math.max(1, Math.min(500, Number(url.searchParams.get("n") ?? 200) || 200));
        return json(res, 200, e.db.trades(now() - d * 86_400_000, n));
      }
      case "/history": {
        const n = Math.max(1, Math.min(MAX_HISTORY, Number(url.searchParams.get("n") ?? MAX_HISTORY) || MAX_HISTORY));
        let hit = historyCache.get(n);
        if (!hit || now() - hit.at > HISTORY_CACHE_MS) {
          if (historyCache.size > 50) historyCache.clear();
          hit = { at: now(), body: `[${e.db.recentEvents(n).join(",")}]` };
          historyCache.set(n, hit);
        }
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" });
        return res.end(hit.body);
      }
      case "/events": {
        const addr = req.socket.remoteAddress ?? "?";
        const mine = streams.get(addr) ?? 0;
        if (streamsTotal >= MAX_STREAMS || mine >= MAX_STREAMS_PER_ADDR) return json(res, 503, { error: "too many live connections" });
        streams.set(addr, mine + 1);
        streamsTotal++;
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          streamsTotal--;
          const left = (streams.get(addr) ?? 1) - 1;
          if (left > 0) streams.set(addr, left);
          else streams.delete(addr);
        };
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        res.write("retry: 2000\n\n");
        const unsub = e.bus.subscribe((line) => {
          if (res.writableLength > MAX_BUFFERED) {
            unsub();
            res.destroy();
            return;
          }
          res.write(`data: ${line}\n\n`);
        });
        req.on("close", () => {
          unsub();
          release();
        });
        return;
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  });
  server.listen(port, bind, () => log.info("engine http listening", { port }));
  return server;
}
