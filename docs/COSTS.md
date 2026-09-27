# Cost model

Stake: **$1,000** (default `START_EQUITY_USD`). Gross notional budget: min(`MAX_TOTAL_NOTIONAL_USD`, equity × `MAX_LEVERAGE`).

## 1. Jev

Price: **$0.042 per 1M input tokens, output free** (docs.typesafe.ai/models, and Vercel AI Gateway lists the same). Limits: 1,200 req/min, 250k tok/s.

Cost per day = `(86,400,000 / TICK_MS) × tokens_per_call × $0.042 / 1e6` (one call per tick covers every lens and position; the call is ~2-3x larger than a single bee's was).

| tick | tokens/call | decisions/min (all 3) | $/day | $/30 days |
|---|---|---|---|---|
| 1 s | 600 | 180 | $6.53 | $196 |
| 1 s | 800 | 180 | $8.71 | $261 |
| 2 s | 800 | 90 | $4.35 | $131 |
| 3 s | 800 | 60 | $2.90 | $87 |
| 5 s | 800 | 36 | $1.74 | $52 |

**Recommendation:** start at `TICK_MS=2000` with `JEV_DAILY_USD_CAP=5`. Drop to 1 s for filming sessions if the shot needs more motion. Measure real `usage.input_tokens` in phase 4; the table is only as good as the tokens-per-call guess.

## 2. Coinbase Derivatives fees

- Coinbase Financial Markets charges a **per-contract commission** on futures (retail nano contracts ~$0.15-$0.20 per side at the time of writing; check the current fee schedule at coinbase.com/derivatives). The engine models this as `TAKER_FEE_RATE` (default 0.05% of notional) in paper mode and reads the real commission from each fill in live mode.
- The agent uses market IOC orders only, so every fill pays the taker side plus the spread (≈ spread_bp × N / 10,000). `SPREAD_GATE_BPS` refuses coins whose spread is too wide.
- `FEE_BUDGET_USD_DAY` and `MAX_TRADES_PER_DAY` are hard caps: once spent, the agent can only hold or close until 00:00 UTC.

## 3. Funding

Coinbase's perpetual-style futures charge funding hourly, accrued against the position. In paper mode the engine charges it at 00:00 / 08:00 / 16:00 UTC from the current rate; live, the exchange settles it. A long held at full size in a normal market costs roughly 4-8%/yr of notional; it turns into a credit when funding is negative.

## 4. Infra

| item | cost |
|---|---|
| VPS (Hetzner CX22 / DigitalOcean basic / Hostinger KVM 1) | $4-9/mo |
| Coinbase account, Derivatives enablement, CDP API key | free |
| Domain for HTTPS (optional) | ~$10-15/yr |

## 5. All-in (budget ceiling, 30 days)

Jev $10-60 depending on `TICK_MS`, fees ≤ `FEE_BUDGET_USD_DAY` × 30, funding ~$10-30, VPS ~$5-9. The dashboard's cost counters show the house's cut in real time; the agent's job is to beat it.
