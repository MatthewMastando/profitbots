# profitbots

One AI trading agent on **Coinbase Derivatives** (US-regulated crypto futures, up to 10x). Every decision comes from
**Jev** (TypeSafe AI's decision model, one `systemOne` call per tick), and every order goes through a risk and
profit-objective layer written in plain code. A live dashboard shows the equity curve, drawdown, P&L breakdowns,
open positions, every fill and every decision.

**It runs on paper by default.** The agent uses real Coinbase market prices and simulated money. Nothing touches an
exchange account unless you change the settings yourself, on purpose.

> **Not financial advice.** profitbots is an experiment and a piece of open-source software. Leveraged crypto trading
> can lose everything you put in. No warranty (see [LICENSE](LICENSE)). If you switch it to real money, that is your
> decision and your risk.

## Why Coinbase Derivatives

For a US resident who wants leverage and the widest range of tradable assets from a bot:

- **Legal in all 50 states.** Coinbase Financial Markets is a CFTC-regulated FCM; retail futures come with up to
  **10x intraday leverage**. Offshore venues (OKX global, Bybit, Hyperliquid…) are not open to US residents.
- **Widest leveraged menu in the US.** ~100 futures products on one API: perpetual-style contracts on BTC, ETH,
  SOL, XRP, DOGE, HYPE, BNB, AAVE, SUI, PEPE, SHIB, ZEC, PAXG and sector indices, plus dated gold, silver, copper, oil
  and equity-index futures (all on by default; `ALLOW_NON_CRYPTO=false` for crypto only). Kraken Derivatives US has ~16 perps and no public trading API for
  them; Kalshi has ~13 at lower leverage.
- **One API for data and trading.** Public market data needs no key; live trading uses one CDP API key with JWT auth.

The engine talks to the exchange through two small interfaces, `PublicApi` (market data) and `Executor` (orders,
positions, fees), both in `src/coinbase/` + `src/exec/`. Swapping venues again means implementing those two.

## How the agent trades

Two **lenses** (ICT and volume/market profile) scan every liquid market, crypto or not. Each tick they are merged into
one Jev menu: opens, and for each open position hold / close / add / trim / flip. Jev picks one with a probability
distribution and conviction; code then sizes it, or vetoes it, and executes. The agent may hold **any number of
positions** at once, capped by gross notional (`MAX_TOTAL_NOTIONAL_USD`, equity × `MAX_LEVERAGE`) and by a
per-position fraction. Details in [`strategies/AGENT.md`](strategies/AGENT.md).

Every tick:

1. **Look.** Coinbase market data: tickers, 15m/1h candles, RSI, MACD, ATR, Bollinger, funding, open interest; from the
   candles, ICT structure (bias, sweeps, displacement, FVGs, order blocks) and the volume profile (POC, VAH/VAL).
2. **Summarise.** A numeric snapshot of the market and every open position.
3. **Ask Jev.** One `choice` + `score` call over the moves that are valid right now.
4. **Check.** Plain code sizes from realised edge (Kelly-lite), enforces leverage and notional caps, stops, profit
   locks, a daily loss stop, trade and fee caps, cooldowns, and a hard daily cap on Jev spend.
5. **Record, then act.** The decision is written to SQLite before anything happens.
6. **Broadcast.** The dashboard streams it live.

Jev is stateless and never sees an order endpoint. If Jev is down or over budget, the agent holds and opens nothing.

## Run it on a server (unattended)

Any Linux VPS with Docker works: a 1 vCPU / 2 GB box (Hetzner CX22 ~€4/mo, DigitalOcean $6/mo, Hostinger KVM 1) is
plenty. Docker restarts the containers on crash and on reboot; the SQLite database lives in a volume with nightly
backups; Caddy terminates HTTPS.

```sh
# on the server
curl -fsSL https://get.docker.com | sh
git clone https://github.com/MatthewMastando/profitbots.git && cd profitbots
cp .env.example .env
nano .env            # set TYPESAFE_API_KEY; set PUBLIC_DOMAIN if you have a domain pointed at this box
docker compose up -d
docker compose logs -f engine
```

Open `http://<server-ip>/` (or `https://<your-domain>/`). That's it: it keeps trading on paper while your laptop is off.

- **HTTPS:** set `PUBLIC_DOMAIN=bots.example.com` (A record → server IP, ports 80/443 open). Caddy fetches and renews
  the certificate itself.
- **Password:** the dashboard is read-only but public. To lock it, uncomment the `basic_auth` block in
  [`Caddyfile`](Caddyfile) with a hash from `docker run --rm caddy caddy hash-password`, then rebuild the web image
  (`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build web`).
- **Alerts:** `ALERT_WEBHOOK_URL` (an [ntfy.sh](https://ntfy.sh) topic works as-is) for cap trips, Jev outages, restarts.
- **Backups:** the `backup` sidecar writes a consistent copy of the database to `/data/backups` every night and keeps
  14 days. Copy them off the box occasionally:
  `docker compose cp backup:/data/backups ./backups-$(date +%F)`.
- **Updating:** `git pull && docker compose pull && docker compose up -d` (or `--build` variant). The data volume is kept.
- **Logs:** `docker compose logs engine`.
- **Stop trading, keep the dashboard:** `docker compose exec engine touch /data/close-dry` (or `close-live`). The engine
  flattens every position and stays up showing the final result.

## Real money (read this twice)

Live trading is **not** the default and there is no button for it.

1. Open a Coinbase account with **Derivatives (futures) enabled** and fund the futures portfolio.
2. Create a **CDP API key** at [portal.cdp.coinbase.com](https://portal.cdp.coinbase.com/access/api): permissions
   **View + Trade only**, never Transfer; **IP-restrict** it to your server. Download the JSON.
3. In `.env` on the server (never commit it, never paste it anywhere else):
   ```
   DRY_RUN=false
   MODE=live
   LIVE_ACK=I-ACCEPT-REAL-MONEY-RISK
   COINBASE_API_KEY_NAME=organizations/…/apiKeys/…
   COINBASE_API_PRIVATE_KEY="-----BEGIN EC PRIVATE KEY-----\n…\n-----END EC PRIVATE KEY-----\n"
   MAX_LEVERAGE=3          # up to 10
   MAX_TOTAL_NOTIONAL_USD=…
   ```
4. `docker compose up -d`. The engine refuses to start if any of the four latches is missing, and the dashboard header
   turns red: **● LIVE MONEY**.

The first hours run at reduced size (`LIVE_SIZE_MULTIPLIER`, `LIVE_RAMP_HOURS`). The bot can never withdraw or
transfer. Reconciliation against Coinbase positions runs continuously and shows in the header. Ending a live run:
`docker compose exec engine touch /data/close-live`.

## Dashboard

- Header: equity, total and today's P&L, drawdown, exposure vs budget, Jev spend, decisions, reconciliation.
- Equity curve with start baseline and crosshair; 24h / 7d / 30d / 90d / 1y windows.
- Performance: net P&L, max drawdown, win rate, profit factor, expectancy, Sharpe, avg win/loss, hold time, costs
  (fees, funding, Jev).
- Daily P&L bars; P&L by coin, side, lens and exit reason; Jev choice distribution, vetoes and forced moves.
- Open positions (entry, mark, stop, open P&L in $ and R); trade log; live decision stream; tradable universe.

## Settings

Everything is documented in [`.env.example`](.env.example). The ones that matter most:

| setting | default | what it does |
|---|---|---|
| `TYPESAFE_API_KEY` | | Jev key. Required. |
| `PUBLIC_DOMAIN` | blank | Domain for automatic HTTPS. |
| `START_EQUITY_USD` | `1000` | Paper stake / P&L baseline. |
| `MAX_LEVERAGE` | `3` | Per-position leverage, 1–10. |
| `MAX_TOTAL_NOTIONAL_USD` | `10000` | Hard cap on gross open notional. |
| `MAX_POSITIONS` | `0` | 0 = unlimited (notional-capped). |
| `TICK_MS` | `10000` | How often Jev is asked. Faster costs more ([docs/COSTS.md](docs/COSTS.md)). |
| `JEV_DAILY_USD_CAP` | `2` | Hard daily cap on Jev spend. |

## Develop

```sh
pnpm install
pnpm test            # Coinbase auth/REST/parsing, config, ledger, risk, engine + Jev, analytics + HTTP
pnpm typecheck && pnpm lint
pnpm dev             # the engine on paper with real Jev calls (needs TYPESAFE_API_KEY in .env)

cd dashboard && pnpm install && pnpm dev    # http://127.0.0.1:5173, proxied to the engine on :8080
```

Layout: `src/coinbase/` (JWT auth, REST, public market data), `src/exec/` (sim + live executors, sizing),
`src/agent/` (state, lenses → one menu), `src/risk.ts` (caps, stops, sizing), `src/engine.ts`, `src/analytics.ts`,
`src/server.ts` (read-only JSON + SSE), `dashboard/` (React + Vite).

## Credits

Forked from Mike Russell's [beebots](https://github.com/imikerussell/beebots) (three bees racing on OKX).
Decisions by [Jev](https://typesafe.ai). MIT licence. No warranty. Not financial advice.
