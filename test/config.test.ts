import { describe, expect, it } from "vitest";
import { LIVE_ACK_PHRASE, loadConfig, VENUE_MAX_LEVERAGE } from "../src/config.js";

const PEM = "-----BEGIN EC PRIVATE KEY-----\\nabc\\n-----END EC PRIVATE KEY-----\\n";

describe("config", () => {
  it("DRY_RUN defaults to true, which forces dry whatever MODE says", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MODE: "live", DRY_RUN: "true" }).mode).toBe("dry");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).creds).toBeNull();
  });

  it("refuses to start without the Jev key", () => {
    expect(() => loadConfig({})).toThrow(/TYPESAFE_API_KEY/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "  " })).toThrow(/TYPESAFE_API_KEY/);
  });

  it("live needs the Coinbase key and lists the missing NAMES only", () => {
    const env = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live", LIVE_ACK: LIVE_ACK_PHRASE, COINBASE_API_KEY_NAME: "organizations/abc/apiKeys/secret-value-1" };
    let msg = "";
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/COINBASE_API_PRIVATE_KEY/);
    expect(msg).not.toMatch(/secret-value-1/);
  });

  it("live needs the written risk acknowledgement, and dry does not", () => {
    const env: Record<string, string> = { TYPESAFE_API_KEY: "k", DRY_RUN: "false", MODE: "live", COINBASE_API_KEY_NAME: "organizations/x/apiKeys/y", COINBASE_API_PRIVATE_KEY: PEM };
    expect(() => loadConfig(env)).toThrow(/LIVE_ACK/);
    expect(() => loadConfig({ ...env, LIVE_ACK: "yes" })).toThrow(/LIVE_ACK/);
    const live = loadConfig({ ...env, LIVE_ACK: LIVE_ACK_PHRASE, COINBASE_PORTFOLIO_ID: "pf-1" });
    expect(live.mode).toBe("live");
    expect(live.creds).toMatchObject({ keyName: "organizations/x/apiKeys/y", portfolioId: "pf-1" });
    // Escaped newlines in the env value become real ones so the PEM parses.
    expect(live.creds!.privateKey).toContain("-----BEGIN EC PRIVATE KEY-----\nabc\n");
    expect(loadConfig({ TYPESAFE_API_KEY: "k" }).mode).toBe("dry");
  });

  it("leverage is capped at the venue maximum", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "k", MAX_LEVERAGE: String(VENUE_MAX_LEVERAGE) }).risk.maxLeverage).toBe(10);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", MAX_LEVERAGE: "11" })).toThrow(/MAX_LEVERAGE/);
    expect(() => loadConfig({ TYPESAFE_API_KEY: "k", MAX_LEVERAGE: "0" })).toThrow(/MAX_LEVERAGE/);
  });

  it("defaults: paper mode, conservative leverage, unlimited positions under the notional cap", () => {
    const c = loadConfig({ TYPESAFE_API_KEY: "k" });
    expect(c.mode).toBe("dry");
    expect(c.risk).toMatchObject({ maxLeverage: 3, maxPositions: 0, maxTotalNotionalUsd: 10_000, maxPositionFrac: 0.5, dailyLossStopPct: 8, retireAtPct: 40 });
    expect(c.tickMs).toBe(10_000);
    expect(c.jev.dailyUsdCap).toBe(2);
    expect(c.dbPath).toBe("./data/agent-dry.sqlite");
    expect(c.coinbase.apiBase).toBe("https://api.coinbase.com");
  });
});
