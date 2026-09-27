# Documentation links

## Jev / TypeSafe AI
- https://docs.typesafe.ai/llms.txt: machine-readable index of every docs page. **Start here.**
- https://docs.typesafe.ai/introduction/quickstart: Playground, curl, full request/response, Python example.
- https://docs.typesafe.ai/api: `POST https://api.typesafe.ai/v1/systemone`. Full schema: `state`, `model`, `questions` (`choice` ≤255 options, `score` 2-10 levels, `noul`); response `answers` + `usage`; errors 401/422/429/529.
- https://docs.typesafe.ai/models: **pricing + rate limits** (`jev-1.13.0`, $0.042/M input, output free, 1,200 req/min, 250k tok/s, 64k context / 32k state+question). *(/pricing, /rate-limits and /errors are 404; this page is the real one.)*
- https://docs.typesafe.ai/sdk/javascript: TypeScript SDK (`@typesafe-ai/sdk` 0.6.0, Node 20+). Source: https://github.com/typesafe-ai/typesafe-sdk-js
- https://docs.typesafe.ai/sdk/python: Python SDK (`typesafe-sdk` 0.7.1).
- https://console.typesafe.ai: API keys (`/keys`) and Playground (`/playground`).
- https://github.com/typesafe-ai/skills: Claude Code skill. Install with `claude plugin marketplace add typesafe-ai/skills` then `claude plugin install typesafe@typesafe-ai`. **Install this before building.**
- https://vercel.com/ai-gateway/models/jev: Jev via Vercel AI Gateway (`typesafe-ai/jev`, same price). A fallback route if the direct API has trouble.

## Coinbase Advanced Trade / Coinbase Derivatives
- https://docs.cdp.coinbase.com/advanced-trade/docs/welcome: Advanced Trade REST API overview. Base `https://api.coinbase.com/api/v3/brokerage`.
- https://docs.cdp.coinbase.com/advanced-trade/docs/rest-api-auth: CDP API keys, JWT auth (ES256 for ECDSA keys, EdDSA for Ed25519), `uri` claim = `METHOD host/path`, 2-minute expiry.
- https://docs.cdp.coinbase.com/advanced-trade/docs/rest-api-rate-limits: public ~10 rps, private ~30 rps.
- Public market data (no key): `GET /market/products?product_type=FUTURE`, `/market/products/{id}`, `/market/products/{id}/candles`, `/market/products/{id}/ticker`.
- Orders: `POST /orders` (market IOC, `client_order_id`); fills `GET /orders/historical/fills`.
- Futures (CFM) account: `GET /cfm/positions`, `GET /cfm/balance_summary`, `GET|POST /cfm/intraday/margin_setting` (intraday leverage up to 10x).
- https://www.coinbase.com/derivatives: product list, contract specs, fee schedule. Retail futures via Coinbase Financial Markets (CFTC-registered FCM).
- https://portal.cdp.coinbase.com/access/api: create the API key (View + Trade only, IP allowlist).

## Venues considered and rejected (US resident)
- Kraken Derivatives US: ~16 perps via NinjaTrader Clearing, no NY/ME, no public trading API for the perps.
- Kalshi perps: ~13 products, ~5.7x max.
- OKX global / Bybit / Hyperliquid: not available to US residents.

## VPS hosting
- https://www.hetzner.com/cloud: CX22 (2 vCPU / 4 GB) is plenty.
- https://www.digitalocean.com/pricing/droplets: $6/mo basic droplet.
- https://www.hostinger.com/vps-hosting: plans (KVM 2: 2 vCPU / 8 GB / 100 GB NVMe / 8 TB).
- https://www.hostinger.com/support/5634532-how-to-generate-ssh-keys-and-add-them-to-hostinger-dashboard/: add your SSH key in hPanel.
- https://www.hostinger.com/support/8306612-how-to-use-the-docker-vps-template-at-hostinger/: Ubuntu 24.04 + Docker template.
- https://www.hostinger.com/support/9615197-how-to-use-the-coolify-vps-template-at-hostinger/: Coolify template (optional).
- https://www.hostinger.com/support/4805502-how-to-set-up-a-firewall-at-vps/: hPanel firewall (drop-all default once on; add 22/80/443).
- https://docs.hostinger.com/api-reference/overview: Hostinger API.

## Strategy research
See [`strategies/AGENT.md`](../strategies/AGENT.md).

## Reference implementation worth reading (not a dependency)
- `jev-trader`: one Jev decision per block, SSE event feed, and a dry run with simulated fills on a real order book. Borrow its **event shape and dashboard idea**, not its venue (it runs on Monad/Kuru).
