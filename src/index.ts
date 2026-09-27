import { existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { positionList } from "./agent/types.js";
import { Alerts } from "./alerts.js";
import { createCoinbaseMarket } from "./coinbase/public.js";
import { createCoinbaseRest } from "./coinbase/rest.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { Db } from "./db.js";
import { Engine } from "./engine.js";
import { EventBus } from "./events.js";
import { CoinbaseExecutor, SimExecutor, type Executor } from "./exec/executor.js";
import { Jev } from "./jev.js";
import { log, setLogLevel } from "./log.js";
import { MarketFeed } from "./market/data.js";
import { safeError } from "./redact.js";
import { startServer } from "./server.js";
import { UpdateCheck } from "./update.js";

/** Static facts for the dashboard. No secrets. */
export function profile(cfg: Config) {
  return {
    mode: cfg.mode,
    venue: "Coinbase Derivatives",
    links: cfg.links,
    maxLeverage: cfg.risk.maxLeverage,
    maxTotalNotionalUsd: cfg.risk.maxTotalNotionalUsd,
    maxPositions: cfg.risk.maxPositions,
    startEquityUsd: cfg.risk.startEquityUsd,
    jevModel: cfg.jev.model,
  };
}

async function main() {
  let cfg: Config;
  try {
    cfg = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      log.error("refusing to start", { reason: err.message });
      process.exit(1);
    }
    throw err;
  }
  setLogLevel(cfg.logLevel);
  log.info("profitbots agent starting", { mode: cfg.mode, tickMs: cfg.tickMs, dataRefreshMs: cfg.dataRefreshMs, jevModel: cfg.jev.model, maxLeverage: cfg.risk.maxLeverage });

  const db = new Db(cfg.dbPath);
  const bus = new EventBus(db);
  const alerts = new Alerts(cfg.alertWebhookUrl);
  const api = createCoinbaseMarket(cfg.coinbase.apiBase, cfg.coinbase.timeoutMs, cfg.coinbase.concurrency, cfg.universe.allowNonCrypto);

  let engine: Engine | null = null;
  const held = () => (engine ? positionList(engine.agent).map((p) => p.instId) : []);
  const feed = new MarketFeed(
    api,
    { min24hVolUsd: cfg.universe.min24hVolUsd, allowNonCrypto: cfg.universe.allowNonCrypto, spreadGateBps: cfg.risk.spreadGateBps, watchCoins: cfg.strategy.watchCoins },
    null,
    held,
  );

  const exec: Executor =
    cfg.mode === "dry" || !cfg.creds
      ? new SimExecutor(() => feed.view(), cfg.risk.takerFeeRate)
      : new CoinbaseExecutor(
          createCoinbaseRest({ apiBase: cfg.coinbase.apiBase, timeoutMs: cfg.coinbase.timeoutMs, concurrency: cfg.coinbase.concurrency, key: cfg.creds }),
          (id) => feed.view().instruments.get(id),
          { leverage: cfg.risk.maxLeverage, portfolioId: cfg.creds.portfolioId },
        );

  const startOfDay = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const jev = new Jev({ ...cfg.jev, spentTodayUsd: db.jevSpendSince(startOfDay) });

  // `deploy/close.sh` drops this file into the data volume to flatten and stop trading cleanly (Engine.windDown).
  const closeFlag = join(dirname(cfg.dbPath), `close-${cfg.mode}`);
  // Dry run only: `resume-last-dry` puts a benched, flat agent back into its last position (consumed on use).
  const resumeFlag = join(dirname(cfg.dbPath), `resume-last-${cfg.mode}`);
  const takeResumeRequest = () => {
    if (cfg.mode !== "dry" || !existsSync(resumeFlag)) return false;
    unlinkSync(resumeFlag);
    return true;
  };
  engine = new Engine({ cfg, db, feed, jev, exec, bus, alerts, closeRequested: () => existsSync(closeFlag), takeResumeRequest });
  await engine.start();

  const updates = new UpdateCheck({ repo: cfg.update.repo, current: cfg.update.version, enabled: cfg.update.enabled });
  updates.start();

  const server = startServer(
    { bus, db, snapshot: () => engine!.snapshot(), health: () => engine!.health(), update: () => updates.status(), profile: () => profile(cfg) },
    cfg.server.port,
    cfg.server.bind,
  );

  const shutdown = (sig: string) => {
    log.info("shutting down", { sig });
    engine?.stop();
    updates.stop();
    server.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error("fatal", { err: safeError(err) });
  process.exit(1);
});
