// One small REST client for Coinbase Advanced Trade: public GETs (cached, bounded concurrency) and signed calls.
import { log } from "../log.js";
import { safeError } from "../redact.js";
import { buildJwt, type JwtKey } from "./auth.js";

export class CoinbaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RestOpts {
  apiBase: string;
  timeoutMs: number;
  /** Max in-flight requests. */
  concurrency: number;
  key?: JwtKey;
  fetchFn?: typeof fetch;
}

export interface CoinbaseRest {
  get<T>(path: string, query?: Record<string, string | number | boolean | string[] | undefined>, ttlMs?: number): Promise<T>;
  /** Signed request (needs a key). */
  signed<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T>;
  readonly authenticated: boolean;
}

type Q = Record<string, string | number | boolean | string[] | undefined>;

export function qs(query: Q | undefined): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

class Gate {
  private running = 0;
  private waiting: Array<() => void> = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }
}

export function createCoinbaseRest(opts: RestOpts): CoinbaseRest {
  const base = opts.apiBase.replace(/\/+$/, "");
  const host = new URL(base).host;
  const fetchFn = opts.fetchFn ?? fetch;
  const gate = new Gate(opts.concurrency);
  const cache = new Map<string, { at: number; p: Promise<unknown> }>();

  async function call<T>(method: "GET" | "POST", path: string, query: Q | undefined, body: unknown, key: JwtKey | undefined): Promise<T> {
    const url = `${base}${path}${qs(query)}`;
    const headers: Record<string, string> = { accept: "application/json" };
    if (key) headers.authorization = `Bearer ${buildJwt(key, method, host, path)}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return gate.run(async () => {
      let res: Response;
      try {
        res = await fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs) });
      } catch (err) {
        const e = safeError(err);
        throw new CoinbaseError(0, e.code || "NETWORK", `coinbase ${method} ${path}: ${e.message}`);
      }
      const text = await res.text();
      let j: unknown = null;
      try {
        j = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error page */
      }
      if (!res.ok) {
        const e = (j ?? {}) as { error?: string; message?: string; error_details?: string };
        log.warn("coinbase http error", { method, path, status: res.status, code: e.error ?? "" });
        throw new CoinbaseError(res.status, e.error ?? String(res.status), e.message ?? e.error_details ?? `HTTP ${res.status}`);
      }
      return j as T;
    });
  }

  return {
    authenticated: !!opts.key,
    get<T>(path: string, query?: Q, ttlMs = 0): Promise<T> {
      const k = `${path}${qs(query)}`;
      const now = Date.now();
      const hit = cache.get(k);
      if (ttlMs > 0 && hit && now - hit.at < ttlMs) return hit.p as Promise<T>;
      const p = call<T>("GET", path, query, undefined, undefined);
      if (ttlMs > 0) {
        cache.set(k, { at: now, p });
        p.catch(() => cache.delete(k));
        if (cache.size > 2000) for (const [kk, v] of cache) if (now - v.at > 60_000) cache.delete(kk);
      }
      return p;
    },
    signed<T>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
      if (!opts.key) return Promise.reject(new CoinbaseError(0, "NO_KEY", "no Coinbase API key configured"));
      return call<T>(method, path, query, body, opts.key);
    },
  };
}
