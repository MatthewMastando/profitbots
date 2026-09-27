# The agent: one book, three lenses, one objective

The agent's only goal is **net profit after fees, funding and Jev spend**. It holds any number of positions at once
(`MAX_POSITIONS=0`), bounded by a gross notional budget rather than a count.

## Lenses (where ideas come from)

| lens | watches | idea |
|---|---|---|
| **breakout** | `BREAKOUT_COINS` | Volatility breakout above/below the previous day's range, ridden with an ATR trail. |
| **trend** | `TREND_COINS` | Multi-timeframe trend score; enters with the trend, sized by volatility target. |
| **momentum** | top `MOMENTUM_CANDIDATES` 7-day movers in the liquid universe | Ride the strongest mover, add to winners, never chase extreme funding. |

Every tick the lenses are combined into **one Jev menu**: opens (each valid setup), and for every open position
`HOLD_*`, `CLOSE_*`, `ADD_*`, `TRIM_*`, `FLIP_*`. `HOLD` is always present. Jev picks one option with a probability
distribution and a conviction score (the same `systemOne` `choice` + `score` call the original bees used). One call per
tick, whatever the number of positions.

## Objective layer (plain code, runs after Jev)

- **Sizing.** Per-position notional = risk budget ÷ stop distance, capped at `MAX_POSITION_FRAC` of the total budget.
  Total budget = min(`MAX_TOTAL_NOTIONAL_USD`, equity × `MAX_LEVERAGE`). Once ~20 trades are closed, `EDGE_SIZING`
  scales size by a Kelly-lite multiplier from realised win rate and payoff (0.5x–1.5x).
- **Profit lock.** Stops ratchet to keep 50% of open profit at +2.5% and 65% at +5%.
- **Costs are first-class.** Opens need `MIN_OPEN_PROB` and `MIN_CONVICTION`; the daily fee budget and trade cap
  stop churn; funding z-score vetoes longs into crowded carry.
- **Stops.** ATR stop, time stop per lens, daily loss stop (`DAILY_LOSS_STOP_PCT`), retirement (`RETIRE_AT_PCT`).
- **Fail closed.** Jev down, over its daily cap, or returning garbage → hold everything, open nothing.

## Never, whatever Jev says

- Leverage above `MAX_LEVERAGE` (hard-capped at 10x, Coinbase's venue max).
- Gross notional above the budget.
- Any key with transfer permission.
