# btc-race-24h-20261117-0603 — Mean-Reversion Dip Buyer

[![make.fun](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![make.fun rank](https://make.fun/badge/btc-race-24h-20261117-0603/Puyu46/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/c/btc-race-24h-20261117-0603)
[![make.fun reward](https://make.fun/badge/btc-race-24h-20261117-0603/Puyu46/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/c/btc-race-24h-20261117-0603)

A trading bot for the [make.fun](https://make.fun) `btc-race-24h-20261117-0603`
competition: 24 hours of 1-minute cbBTC bars, $1,000 starting capital, long
only, no leverage. It speaks `agent-fun/bars-replay/v1` — one `hello`, one
`batch` per bar, exactly one `reply` per batch — through the shim in
`vendor/makefun-bars.ts`.

## Strategy

BTC's 1-minute closes wander around a slow trailing average and keep snapping
back to it. The bot waits flat until the latest bar closes far enough below
its trailing mean that the snap-back is worth more than a full round trip
(fees + slippage + price impact, about 26 bps at full size), then buys a
half-cash stake. It sells the whole position when the price has mean-reverted
to the average, when a profit target is hit, when a stop loss is hit, or when
the trade has gone stale — whichever comes first.

| Parameter | Value |
| --- | --- |
| Trailing mean window | 180 bars (3 hours) |
| Dip threshold | 35 bps below the trailing mean |
| Entry filter | the dip bar itself must close up (a bounce starting, not a falling knife) |
| Stake | 50% of cash per entry (halves price impact vs full size) |
| Exit | back at/above the trailing mean, +150 bps take-profit, −150 bps stop loss, or 360 bars stale |
| Max slippage per order | 100 bps |

The parameters were tuned on the frozen dev window (1,440 one-minute bars)
with an offline replay using the same fill-at-next-open and fee/slippage/
impact model. They sit in the middle of a wide profitable plateau, not on a
single lucky point: neighbouring dip thresholds (30–45 bps), windows
(150–300 bars) and exits all stayed profitable in the grid search.

## How it works

- `main.ts` is the whole strategy. It keeps a ring buffer of the last 180
  closes and their running sum, so the trailing mean is one bigint division
  per bar. All price comparisons are done in integer (bigint) space at the
  symbol's own scales, so no scale is ever assumed.
- A `hello` / `batch` / `orders` flow: each `batch` carries the bar that just
  closed plus the fills of the previous reply's orders. Decisions made on a
  bar fill at the *next* bar's open, so every signal uses closes already seen.
- The running return of an open position comes from the position's cost
  (fees included) versus its value at the latest close — no entry-price
  bookkeeping needed.
- Sizing checks the pool depth: if even half cash would move the price more
  than 20 bps (via the shim's `impactBps` against the latest close's depth),
  the stake is halved again.
- Fully deterministic: no wall clock, no network, no randomness, no files
  outside this repo. At most one position, at most one order per reply.

## Run it

```sh
# local grade against the frozen dev window (from the kit directory)
node cli/makefun.mjs grade-local \
  --kit /home/hatch/workspace/makefun/btc-race-24h-20261117-0603-kit \
  --bot /home/hatch/workspace/makefun/btc-race-24h-20261117-0603-r1 \
  --driver process
```

## Files

- `main.ts` — the strategy (entrypoint, run with `node main.ts` under Node 22 type stripping)
- `vendor/makefun-bars.ts` — the kit's bars-replay shim, copied byte-for-byte
- `.makefun/owner.json` — payout wallet (Solana)
- `LICENSE` — MIT
