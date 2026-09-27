# The agent: one book, two lenses, one objective

The agent's only goal is **net profit after fees, funding and Jev spend**. It holds any number of positions at once
(`MAX_POSITIONS=0`), bounded by a gross notional budget rather than a count.

## Universe

Every live Coinbase Derivatives contract that passes the gates: 24h volume ≥ `MIN_24H_VOL_USD`, spread ≤
`SPREAD_GATE_BPS`, session open, classified (crypto, metals/energy, equity index). Dated contracts are dropped three
days before expiry so nothing is opened into a roll. `ALLOW_NON_CRYPTO=false` restricts it to crypto perps.
Non-crypto futures trade CME-style sessions: outside the session the ticker has no quote and the contract simply
falls out of the universe until it reopens; open positions keep their stops and are closed on the next quote.

## Lenses (where ideas come from)

Both lenses read 15m candles for entries and 1h candles for context, on every gated market. The best
`MAX_MENU_SETUPS` (ranked by setup quality) reach Jev each tick.

| lens | setup | idea | stop |
|---|---|---|---|
| **ict** | `ICT_LONG_X` / `ICT_SHORT_X` (`sweep_fvg`, `ob_retest`) | Trade with the 1h structure bias after a 15m liquidity sweep (wick through a swing or the prior-day high/low that closes back) and a displacement candle (body ≥ 1.5 ATR that shifts structure). Entry when price returns to the fair value gap / order block the move left. Killzones (London 07–10, NY 12–15 and 18:30–20 UTC) raise the rank. | Under the sweep wick / order block; trails the last 15m swing. 12h time stop. |
| **vprofile** | `VP_ROTATION_*` (`rotation`) | Price at VAL/VAH of the 5-session composite profile while still inside value: fade back to the POC. | Just outside the value edge, never wider than the ATR stop. TRIM offered when the POC is reached. |
| **vprofile** | `VP_RULE80_*` (`rule80`) | Opened outside yesterday's value area and traded back inside: aim for the far edge. | Same as rotation. |
| **vprofile** | `VP_ACCEPT_*` (`acceptance`) | Two confirmed 15m closes outside value: go with the breakout toward the next low-volume node. One close shows as a `loose` option Jev sees but the risk layer will not fill. | Back inside value; trails the edge that was broken. 48h time stop. |

`FLIP_*` appears when structure shifts against an ICT position or price is accepted outside value against a profile
position. Crowded longs (30-day funding z > 1.5) are never offered.

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
