import { z } from "zod";

/** Typed as the only acknowledgement that unlocks MODE=live. */
export const LIVE_ACK_PHRASE = "I-ACCEPT-REAL-MONEY-RISK";
/** Coinbase Derivatives' stated intraday maximum. Nothing in this program may exceed it. */
export const VENUE_MAX_LEVERAGE = 10;

export type Mode = "dry" | "live";

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : /^(1|true|yes|on)$/i.test(v.trim())));
const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === "") return def;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a number" });
        return z.NEVER;
      }
      return n;
    });
const str = (def: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? def : v.trim()));
const opt = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));
const list = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ""
        ? def
        : v
            .split(",")
            .map((x) => x.trim().toUpperCase())
            .filter(Boolean),
    );

const EnvSchema = z.object({
  // DRY_RUN=true (the default) forces MODE=dry whatever MODE says. Going live needs both DRY_RUN=false and MODE=live.
  DRY_RUN: bool(true),
  MODE: z.enum(["dry", "live"]).optional().default("dry"),

  TYPESAFE_API_KEY: opt,
  JEV_MODEL: str("jev-1.13.0"),
  JEV_TIMEOUT_MS: num(2000),
  JEV_DAILY_USD_CAP: num(2),
  JEV_USD_PER_MTOK: num(0.042),
  TICK_MS: num(10_000),
  DATA_REFRESH_MS: num(60_000),

  // Coinbase Advanced Trade (Coinbase Derivatives futures). CDP API key: the key name and its PEM (ECDSA) or
  // base64 (Ed25519) private key. Live only; paper trading needs none of it.
  COINBASE_API_BASE: str("https://api.coinbase.com"),
  COINBASE_API_KEY_NAME: opt,
  COINBASE_API_PRIVATE_KEY: opt,
  COINBASE_PORTFOLIO_ID: opt,
  COINBASE_TIMEOUT_MS: num(15_000),
  /** Public candle/ticker calls run at most this many at once (Coinbase public limit is ~10 rps). */
  COINBASE_CONCURRENCY: num(4),

  START_EQUITY_USD: num(1000),
  MAX_LEVERAGE: num(3),
  MAX_TOTAL_NOTIONAL_USD: num(10_000),
  /** One position may use at most this fraction of the total notional cap. */
  MAX_POSITION_FRAC: num(0.5),
  /** 0 = unlimited (the total notional cap is the only limit). */
  MAX_POSITIONS: num(0),
  DAILY_LOSS_STOP_PCT: num(8),
  RETIRE_AT_PCT: num(40),
  MAX_TRADES_PER_DAY: num(12),
  FEE_BUDGET_USD_DAY: num(25),
  SPREAD_GATE_BPS: num(10),
  COOLDOWN_MINUTES: num(3),
  STOP_ATR_MULT: num(2),
  MIN_OPEN_PROB: num(0.55),
  MIN_CONVICTION: num(1),
  /** Scale new positions by realised edge (Kelly-lite). Off = every open uses the lens' base size. */
  EDGE_SIZING: bool(true),
  LIVE_SIZE_MULTIPLIER: num(0.25),
  LIVE_RAMP_HOURS: num(2),
  MIN_24H_VOL_USD: num(1_000_000),
  ALLOW_NON_CRYPTO: bool(true),
  TAKER_FEE_RATE: num(0.0005),
  WATCH_COINS: list(["BTC", "ETH"]),
  MAX_MENU_SETUPS: num(8),
  // Real money needs DRY_RUN=false, MODE=live AND this set to LIVE_ACK_PHRASE.
  LIVE_ACK: opt,

  ENGINE_PORT: num(8080),
  ENGINE_BIND: str("127.0.0.1"),
  // "{mode}" is replaced with dry/live, so each mode keeps its own books.
  DB_PATH: str("./data/agent-{mode}.sqlite"),
  REPO_LINK: str("https://github.com/MatthewMastando/profitbots"),
  UPDATE_CHECK: bool(false),
  UPDATE_REPO: str("MatthewMastando/profitbots"),
  APP_VERSION: str("dev"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).optional().default("info"),
  ALERT_WEBHOOK_URL: opt,
});

export interface CoinbaseCreds {
  keyName: string;
  privateKey: string;
  portfolioId?: string;
}

export interface Config {
  mode: Mode;
  links: { code: string };
  update: { enabled: boolean; repo: string; version: string };
  jev: { apiKey: string; model: string; timeoutMs: number; dailyUsdCap: number; usdPerMTok: number };
  tickMs: number;
  dataRefreshMs: number;
  coinbase: { apiBase: string; timeoutMs: number; concurrency: number };
  /** Live credentials. Never logged, never sent to the dashboard. */
  creds: CoinbaseCreds | null;
  risk: {
    startEquityUsd: number;
    maxLeverage: number;
    maxTotalNotionalUsd: number;
    maxPositionFrac: number;
    maxPositions: number;
    dailyLossStopPct: number;
    retireAtPct: number;
    maxTradesPerDay: number;
    feeBudgetUsdDay: number;
    spreadGateBps: number;
    cooldownMinutes: number;
    stopAtrMult: number;
    minOpenProb: number;
    minConviction: number;
    edgeSizing: boolean;
    liveSizeMultiplier: number;
    liveRampHours: number;
    takerFeeRate: number;
  };
  universe: { min24hVolUsd: number; allowNonCrypto: boolean };
  strategy: { watchCoins: string[]; maxMenuSetups: number };
  server: { port: number; bind: string };
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  alertWebhookUrl?: string;
}

export class ConfigError extends Error {}

/** Parse and validate the environment. Throws ConfigError listing NAMES only, never values. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid settings:\n  ${names.join("\n  ")}`);
  }
  const e = parsed.data;
  const mode: Mode = e.DRY_RUN ? "dry" : e.MODE;

  const missing: string[] = [];
  if (!e.TYPESAFE_API_KEY) missing.push("TYPESAFE_API_KEY");
  if (mode === "live" && e.LIVE_ACK !== LIVE_ACK_PHRASE) {
    throw new ConfigError(`MODE=live moves real money. Set LIVE_ACK=${LIVE_ACK_PHRASE} to confirm you accept the risk, or go back to DRY_RUN=true.`);
  }
  if (e.MAX_LEVERAGE > VENUE_MAX_LEVERAGE || e.MAX_LEVERAGE <= 0) throw new ConfigError(`MAX_LEVERAGE must be in (0, ${VENUE_MAX_LEVERAGE}] (Coinbase Derivatives' intraday maximum).`);
  if (e.MAX_POSITION_FRAC <= 0 || e.MAX_POSITION_FRAC > 1) throw new ConfigError("MAX_POSITION_FRAC must be in (0, 1]");
  if (e.MAX_POSITIONS < 0) throw new ConfigError("MAX_POSITIONS must be >= 0 (0 = unlimited)");
  if (e.START_EQUITY_USD <= 0) throw new ConfigError("START_EQUITY_USD must be > 0");

  let creds: CoinbaseCreds | null = null;
  if (mode === "live") {
    if (!e.COINBASE_API_KEY_NAME) missing.push("COINBASE_API_KEY_NAME");
    if (!e.COINBASE_API_PRIVATE_KEY) missing.push("COINBASE_API_PRIVATE_KEY");
    if (e.COINBASE_API_KEY_NAME && e.COINBASE_API_PRIVATE_KEY) {
      creds = { keyName: e.COINBASE_API_KEY_NAME, privateKey: e.COINBASE_API_PRIVATE_KEY.replaceAll("\\n", "\n"), portfolioId: e.COINBASE_PORTFOLIO_ID };
    }
  }
  if (missing.length) throw new ConfigError(`MODE=${mode} needs these settings, which are blank or missing:\n  ${missing.join("\n  ")}`);

  return {
    mode,
    links: { code: e.REPO_LINK },
    update: { enabled: e.UPDATE_CHECK, repo: e.UPDATE_REPO, version: e.APP_VERSION },
    jev: { apiKey: e.TYPESAFE_API_KEY!, model: e.JEV_MODEL, timeoutMs: e.JEV_TIMEOUT_MS, dailyUsdCap: e.JEV_DAILY_USD_CAP, usdPerMTok: e.JEV_USD_PER_MTOK },
    tickMs: Math.max(1000, e.TICK_MS),
    dataRefreshMs: Math.max(15_000, e.DATA_REFRESH_MS),
    coinbase: { apiBase: e.COINBASE_API_BASE.replace(/\/+$/, ""), timeoutMs: e.COINBASE_TIMEOUT_MS, concurrency: Math.max(1, Math.floor(e.COINBASE_CONCURRENCY)) },
    creds,
    risk: {
      startEquityUsd: e.START_EQUITY_USD,
      maxLeverage: e.MAX_LEVERAGE,
      maxTotalNotionalUsd: e.MAX_TOTAL_NOTIONAL_USD,
      maxPositionFrac: e.MAX_POSITION_FRAC,
      maxPositions: Math.floor(e.MAX_POSITIONS),
      dailyLossStopPct: e.DAILY_LOSS_STOP_PCT,
      retireAtPct: e.RETIRE_AT_PCT,
      maxTradesPerDay: e.MAX_TRADES_PER_DAY,
      feeBudgetUsdDay: e.FEE_BUDGET_USD_DAY,
      spreadGateBps: e.SPREAD_GATE_BPS,
      cooldownMinutes: e.COOLDOWN_MINUTES,
      stopAtrMult: e.STOP_ATR_MULT,
      minOpenProb: e.MIN_OPEN_PROB,
      minConviction: e.MIN_CONVICTION,
      edgeSizing: e.EDGE_SIZING,
      liveSizeMultiplier: e.LIVE_SIZE_MULTIPLIER,
      liveRampHours: e.LIVE_RAMP_HOURS,
      takerFeeRate: e.TAKER_FEE_RATE,
    },
    universe: { min24hVolUsd: e.MIN_24H_VOL_USD, allowNonCrypto: e.ALLOW_NON_CRYPTO },
    strategy: { watchCoins: e.WATCH_COINS, maxMenuSetups: Math.max(1, Math.floor(e.MAX_MENU_SETUPS)) },
    server: { port: e.ENGINE_PORT, bind: e.ENGINE_BIND },
    dbPath: e.DB_PATH.replaceAll("{mode}", mode),
    logLevel: e.LOG_LEVEL,
    alertWebhookUrl: e.ALERT_WEBHOOK_URL,
  };
}
