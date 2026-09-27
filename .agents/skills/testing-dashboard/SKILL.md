---
name: test-profitbots-dashboard
description: Run the single-agent Coinbase paper dashboard locally and distinguish Jev failure, rule-only decisions, and degraded public market data.
---

## Devin Secrets Needed
- `TYPESAFE_API_KEY` for real Jev decisions. Never supply exchange credentials for dashboard-only testing.
- When explicitly authorized to test unavailable-Jev behavior, use `TYPESAFE_API_KEY=test` with `DRY_RUN=true MODE=dry`. A dummy key cannot prove successful model selection or trading.

## Local setup
- Use the Node/pnpm versions pinned by the project; install root and dashboard dependencies through the environment blueprint.
- Run `pnpm dev` at the repo root with explicit paper-mode environment overrides.
- Run `pnpm dev` in `dashboard/`. On macOS Vite may bind IPv6 localhost only: open `http://localhost:5173`, not `http://127.0.0.1:5173`.
- Engine API is `http://127.0.0.1:8080`. The HTTP server starts after initial public market refresh, which may take time.
- Restart the engine after backend changes (`tsx src/index.ts` is not watch mode); frontend CSS/React changes hot-reload.
- Preserve existing paper DB unless a reset is explicitly requested. Do not seed trades and present them as live market outcomes.

## UI/runtime checks
- Top-right tabs map 24h/7d/30d/90d/1y to days=1/7/30/90/365 for equity, analytics and trades.
- `agent.window` and `agent.sound` are localStorage preferences. An enabled sound preference activates on the first pointer gesture after reload due to browser audio policy.
- SSE decisions arrive about every 10 seconds. Snapshot polling is 5 seconds; analytics polling is 30 seconds, so counters can briefly differ.
- A decision count increasing with `WATCHING` and zero Jev asks does not verify unavailable-Jev handling. Actual failure evidence includes asks/errors increasing, `Jev unreachable: holding`, `jev_unreachable` vetoes, and zero orders/positions.
- Verify universe chips against real public feed. Public Coinbase rate limiting can reduce quotes/candles while health remains green: inspect engine warnings and report degraded market coverage.
- Multiple futures contracts may share a coin symbol; check both ordinary and spread-blocked chips for stable identity and console errors.
- Test at 390px and inspect actual control bounds, not only document scroll width: hidden horizontal overflow can conceal off-screen controls.
- Record screenshots for visual assertions and collect console/network/SSE separately. Keep intentional restart disconnection errors separate from steady-state runtime errors.

## Read-only API
- GET health/profile/snapshot/equity/analytics/trades/history should produce JSON; events is SSE.
- POST must return 405/read-only.
- No browser login is required locally; unauthenticated HTTP checks are appropriate. Do not claim real secret-redaction coverage when only a dummy key exists.
