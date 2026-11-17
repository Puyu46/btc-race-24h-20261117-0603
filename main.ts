// btc-race-24h-20261117-0603 — cbBTC 1-minute mean-reversion dip buyer.
//
// Strategy in one paragraph: BTC's 1-minute closes wander around a slow
// trailing average and keep snapping back to it. This bot waits, flat, until
// the latest bar closes far enough below its trailing mean that the snap-back
// is worth more than a full round trip (fees + slippage + price impact, about
// 26 bps at full size), then buys a half-cash stake. It sells the whole
// position when the price has mean-reverted to the average, when a profit
// target is hit, when a stop loss is hit, or when the trade has gone stale —
// whichever comes first. One position at a time, long only, no leverage.
//
// Protocol: agent-fun/bars-replay/v1. The shim in vendor/makefun-bars.ts owns
// the wire: one hello, then one batch per bar, and exactly one reply per
// batch. An onBatch decision fills at the NEXT bar's open, so every signal
// here is computed from closes the bot has already seen. The bot is fully
// deterministic: no wall clock, no network, no randomness, no files outside
// this repo. Prices are integers at the symbol's price_scale, quote amounts
// are integers at quote_scale (micro-USDC); all comparisons below are done in
// integer (bigint) space so no scale ever has to be assumed.
//
// Tuned on the frozen dev window (1,440 one-minute bars) with an offline
// replay that prices fills at the next open with the same fee / slippage /
// impact model. The chosen parameters were the centre of a wide plateau, not
// a single lucky point: neighbouring dip thresholds, windows and exits all
// stayed profitable in the grid search.
//
//   trailing window ......... 180 bars (3 hours)
//   dip threshold ........... 35 bps below the trailing mean
//   entry filter ............ the dip bar itself must close up (a bounce
//                             starting, not a knife still falling)
//   stake ................... 50% of cash per entry (halves the price
//                             impact versus full size, keeps drawdown small)
//   exit .................... close back at/above the trailing mean, or
//                             +150 bps take-profit, or -150 bps stop loss,
//                             or 360 bars stale
//   max slippage per order .. 100 bps

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (bps unless noted) -------------------------------
const WINDOW_BARS = 180; // trailing mean window, in bars
const DIP_BPS = 35n; // buy only this far below the trailing mean
const TAKE_PROFIT_BPS = 150n; // sell at this gain over the entry cost
const STOP_LOSS_BPS = 150n; // sell at this loss under the entry cost
const STALE_BARS = 360; // sell a trade this old even if it never reverted
const STAKE_NUM = 1n; // buy stake = STAKE_NUM / STAKE_DEN of cash
const STAKE_DEN = 2n;
const MAX_SLIPPAGE_BPS = 100; // per order, measured from the latest close
const BPS = 10_000n;

// --- rolling state ---------------------------------------------------------
// Ring buffer of the last WINDOW_BARS closes (raw price-scale integers) and
// their running sum, so the trailing mean is one bigint division per bar.
const closes: bigint[] = [];
let closesSum = 0n;
let heldSinceBar = -1; // seq of the bar on which the current position opened

/** Trailing mean of the closes seen so far, or null until the window is full. */
function trailingMean(): bigint | null {
  if (closes.length < WINDOW_BARS) return null;
  return closesSum / BigInt(WINDOW_BARS);
}

/** Signed gap of `price` versus `mean`, in bps (negative = below the mean). */
function gapBps(price: bigint, mean: bigint): bigint {
  return (price * BPS) / mean - BPS;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Every batch carries exactly one bar for our single symbol; fold its
    // close into the trailing window before deciding anything on it.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar !== undefined) {
      const close = BigInt(bar.c);
      closes.push(close);
      closesSum += close;
      if (closes.length > WINDOW_BARS) closesSum -= closes.shift()!;
    }

    // Warm-up batches exist only to build history: orders decided on one are
    // rejected, so never trade while the harness is still warming up.
    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    const mean = trailingMean();
    if (close === null || mean === null || bar === undefined) return [];

    const held = state.positions.get(SYMBOL);
    const orders: OrderInput[] = [];

    if (held === undefined || held.qty === 0n) {
      // Flat: look for a dip worth buying. The buy fills at the next bar's
      // open, so the entry filter reads the bar that just closed: it must
      // have closed up (close above its own open) — a bounce starting, not
      // a price still sliding away from the mean.
      const dipped = gapBps(close, mean) <= -DIP_BPS;
      const bouncing = close > BigInt(bar.o);
      if (!dipped || !bouncing) return [];

      // Half the cash. If the pool is thin enough that even half cash would
      // move the price a lot, halve the stake again; the shim's impactBps
      // prices the trade against the latest close's depth.
      let stake = (state.cash * STAKE_NUM) / STAKE_DEN;
      const impact = state.impactBps(SYMBOL, stake);
      if (impact !== null && impact > 20n) stake /= 2n;
      const room = state.weightRoom(SYMBOL);
      if (stake > room) stake = room;
      if (stake <= 0n) return [];
      heldSinceBar = state.seq;
      orders.push({
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: stake,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      return orders;
    }

    // Holding: decide whether this bar is the exit. The position's cost
    // (fees included) and its value at the latest close give the running
    // return in bps without ever needing the entry fill price.
    const value = state.value(SYMBOL, held.qty, close);
    const pnlBps = ((value - held.cost) * BPS) / held.cost;
    const reverted = gapBps(close, mean) >= 0n;
    const tookProfit = pnlBps >= TAKE_PROFIT_BPS;
    const stoppedOut = pnlBps <= -STOP_LOSS_BPS;
    const stale = heldSinceBar >= 0 && state.seq - heldSinceBar >= STALE_BARS;
    if (reverted || tookProfit || stoppedOut || stale) {
      heldSinceBar = -1;
      orders.push({
        side: 'sell',
        symbol: SYMBOL,
        qty: held.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
    return orders;
  },
});
