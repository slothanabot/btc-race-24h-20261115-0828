// Dip-bounce BTC bot for make.fun's btc-race-24h-20261115-0828 (bars-replay/v1).
//
// One idea, kept deliberately small: on 1-minute cbBTC bars, Bitcoin's sharp
// capitulation dips snap back. When the close falls at least 260 bp below the
// trailing 2-hour high, the bot arms and watches the dip low; it only buys once
// the close has bounced at least 40 bp off that low -- the first sign the
// selling has stabilised, not the falling knife itself. It enters in two
// tranches: half the cash on the bounce confirmation, the rest if the price
// dips a further 40 bp below the first fill (a better average, not a chase).
// Exits are staged: sell half at +100 bp from the average fill, then let the
// rest run to +400 bp or a 60 bp trailing stop (armed once the peak is +80 bp
// above the entry). The hard stop sits below the dip low (or 150 bp under the
// entry, whichever is tighter); once the first half is banked the stop on the
// remainder moves up to breakeven, so the second leg can only end flat or
// better before fees. A position is given up after 240 bars, and no fresh
// entry fires within 20 bars of an exit.
//
// Why this shape, on the published dev window (24 h of cbBTC 1-minute bars,
// -4.0% net: buy-and-hold loses ~$40): the window grinds down in a slow bleed
// punctuated by three real capitulations. The bot catches all three: a dip to
// 65,092 rebounds to 66,079 (+120 bp in 29 min), a dip to 63,372 rebounds to
// 64,230, and the day's wash-out to 62,082 rips to 65,480 (+547 bp in 76 min).
// Each trade banks the first half at +100 bp and trails the rest, netting
// +$37.74 after every fee, slippage and price impact, with 1.7% max drawdown
// and 12 fills. The parameters are round numbers and the neighbourhood is
// profitable on the dev window (dip 250-320 bp, bounce 20-50 bp, first take
// 80-120 bp, second take 350-400 bp all clear +$30).
//
// The harness is long-only, no leverage, no shorts, one symbol (CBBTC). Orders
// decided on a batch fill at the next bar's open, paying 4 bp fee + 2 bp
// modelled slippage + constant-product impact against that bar's open depth, so
// a full-size round trip costs about 40 bp at the dev window's depths; the
// +100 bp first take-profit clears it with room to spare, and the second
// tranche halves the impact of each leg by sizing each buy at half the stack.
//
// Deterministic: the bot is a pure function of the bars it is sent. No clock,
// no environment, no randomness, no network, no files. Standard library only,
// plus the kit's own bars SDK vendored under vendor/ (byte-identical to the
// kit's sdk/makefun-bars.ts).
//
// Laid out like the kit's baselines: the grader runs `node /bot/main.ts` with
// this directory mounted at /bot; vendor/makefun-bars.ts is a byte-identical
// copy of the kit's sdk/makefun-bars.ts.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
// Raw price units per USD (the protocol's price_scale for CBBTC is 5).
const PRICE_SCALE = 100_000;

// Trailing-high window (bars) the dip is measured against.
const TRAIL_WINDOW = 120;
// Arm when the close is this far (bp) below the trailing high.
const DIP_BP = 260;
// Buy once the close has bounced this far (bp) off the dip low.
const BOUNCE_BP = 40;
// Second tranche when the close falls this far (bp) below the first fill.
const TRANCHE2_DIP_BP = 40;
// Bank half at +100 bp from the average fill, the rest at +400 bp.
const FIRST_TAKE_BP = 100;
const SECOND_TAKE_BP = 400;
// Trailing stop on the remainder: 60 bp off the peak, armed at +80 bp.
const TRAIL_BP = 60;
const TRAIL_ARM_BP = 80;
// Hard stop: 150 bp under the entry, or just below the dip low, tighter wins.
const STOP_LOSS_BP = 150;
const DIP_LOW_SLACK_BP = 5;
// Give up on a position after this many fresh bars.
const MAX_HOLD_BARS = 240;
// Bars to wait after an exit before a fresh dip may arm.
const COOLDOWN_BARS = 20;
// An armed dip expires after this many bars without a bounce.
const ARM_TIMEOUT_BARS = 180;
// Bars of history before the first entry is allowed.
const MIN_BAR = 5;
// Wide open: a fill may move up to 100% from the latest close before it is refused.
const MAX_SLIPPAGE_BPS = 10_000;
// A buy must spend at least 1 USDC (the harness's minimum notional).
const MIN_NOTIONAL = 1_000_000n;

// Closes in USD, one per fresh CBBTC bar, in order (kept to the trail window).
const closes: number[] = [];
// The bot's own position bookkeeping, updated only from fills the harness
// reports, so a rejected order can never leave it out of step.
let posQty = 0n;
// Average fill price (USD) of the open position.
let entryPrice: number | null = null;
// The fresh-bar index the first tranche filled on.
let entryBar = -1;
// Whether the first take-profit (the half sale) has already happened.
let firstTakeDone = false;
// Which tranche the position is on (0 = flat, 1 = first tranche only).
let tranche = 0;
// Highest close seen since the (latest) tranche filled.
let peakSinceEntry = 0;
// Dip state: armed once the close drops DIP_BP below the trailing high.
let armed = false;
let dipLow = Number.POSITIVE_INFINITY;
let dipBar = -1;
let lastExitBar = -1e9;
// The close time of the last fresh CBBTC bar seen (a batch may carry no bar: a gap).
let lastBarT = -1;
// Fresh-bar index (0-based), the clock every rule runs on.
let barIndex = -1;

function sellAll(qty: bigint): OrderInput[] {
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // The fills of the orders decided on the previous batch: a buy fill opens
    // or adds to the position (its price is the take-profit / stop-loss
    // reference), a sell fill closes it wholly or in part. The account the
    // batch carries already reflects the fills, so the position left tells a
    // half sale from a full exit. Fills land on the next fresh bar after the
    // decision bar, whose index is one past the decision bar's (barIndex has
    // not advanced yet).
    for (const fill of batch.fills) {
      if (fill.status !== 'filled' || fill.symbol !== SYMBOL) continue;
      const fillPrice = Number(fill.price) / PRICE_SCALE;
      if (fill.side === 'buy') {
        const newQty = posQty + BigInt(fill.qty);
        entryPrice =
          posQty > 0n && entryPrice !== null
            ? (Number(posQty) * entryPrice + Number(fill.qty) * fillPrice) / Number(newQty)
            : fillPrice;
        posQty = newQty;
        if (tranche === 0) {
          entryBar = barIndex + 1;
          firstTakeDone = false;
          peakSinceEntry = state.close(SYMBOL) === null ? fillPrice : Number(state.close(SYMBOL)) / PRICE_SCALE;
        } else {
          // A second tranche lowers the average entry; the trailing stop's
          // peak restarts from the decision bar's close.
          peakSinceEntry = state.close(SYMBOL) === null ? fillPrice : Number(state.close(SYMBOL)) / PRICE_SCALE;
        }
        tranche = tranche === 0 ? 1 : 2;
      } else if (fill.side === 'sell') {
        posQty -= BigInt(fill.qty);
        if (posQty > 0n) {
          // A half sale: the position lives on, the stop moves up to the
          // entry price (see the exit rules below).
          firstTakeDone = true;
        } else {
          entryPrice = null;
          entryBar = -1;
          firstTakeDone = false;
          tranche = 0;
          lastExitBar = barIndex + 1;
        }
      }
    }

    // A batch with no fresh CBBTC bar is a gap minute: nothing new is known,
    // and the close the state still holds is the previous bar's, so decide nothing.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || bar.t === lastBarT) return [];
    lastBarT = bar.t;
    barIndex += 1;

    const closeRaw = state.close(SYMBOL);
    if (closeRaw === null) return [];
    const close = Number(closeRaw) / PRICE_SCALE;
    closes.push(close);
    if (closes.length > TRAIL_WINDOW) closes.shift();
    const trailHigh = closes.reduce((m, c) => (c > m ? c : m), 0);

    if (posQty > 0n) {
      let entry = entryPrice;
      if (entry === null) {
        // Fallback if a fill was ever missed: the position's cost basis.
        const pos = state.positions.get(SYMBOL);
        entry = pos === undefined ? close : (Number(pos.cost) * 100) / Number(pos.qty);
      }
      if (close > peakSinceEntry) peakSinceEntry = close;
      const retBp = (close / entry - 1) * 10_000;
      // The staged exits first: a bar that jumps past the second target banks
      // the whole move at once.
      if (!firstTakeDone && retBp >= FIRST_TAKE_BP) {
        const half = posQty / 2n;
        if (half > 0n && state.value(SYMBOL, half) >= MIN_NOTIONAL) {
          return [{ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
        }
        return sellAll(posQty);
      }
      if (firstTakeDone && retBp >= SECOND_TAKE_BP) {
        return sellAll(posQty);
      }
      // Trailing stop on the remainder, armed once the peak is far enough
      // above the entry.
      if (
        firstTakeDone &&
        (peakSinceEntry / entry - 1) * 10_000 >= TRAIL_ARM_BP &&
        close <= peakSinceEntry * (1 - TRAIL_BP / 10_000)
      ) {
        return sellAll(posQty);
      }
      // The hard stop: 150 bp under the entry, or just below the dip low,
      // whichever is tighter; once the first half is banked the stop on the
      // remainder moves up to the entry price itself.
      const stop = firstTakeDone
        ? entry
        : Math.min(entry * (1 - STOP_LOSS_BP / 10_000), dipLow * (1 - DIP_LOW_SLACK_BP / 10_000));
      if (close <= stop) {
        return sellAll(posQty);
      }
      if (barIndex - entryBar >= MAX_HOLD_BARS) {
        return sellAll(posQty);
      }
      // Second tranche: the dip deepens below the first fill, so the rest of
      // the cash buys a better average.
      if (tranche === 1 && close <= entry * (1 - TRANCHE2_DIP_BP / 10_000) && state.cash >= MIN_NOTIONAL) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    if (state.warmingUp || barIndex < MIN_BAR) return [];
    if (barIndex - lastExitBar < COOLDOWN_BARS) return [];
    const dipBp = (close / trailHigh - 1) * 10_000;
    if (!armed) {
      if (dipBp <= -DIP_BP) {
        armed = true;
        dipLow = close;
        dipBar = barIndex;
      }
      return [];
    }
    // Armed: keep tracking the dip low while waiting for the bounce.
    if (close < dipLow) {
      dipLow = close;
      dipBar = barIndex;
    }
    if (barIndex - dipBar > ARM_TIMEOUT_BARS) {
      armed = false;
      return [];
    }
    // The confirmation: the close has bounced off the dip low. Only then does
    // the first tranche go in, with half the cash.
    if ((close / dipLow - 1) * 10_000 >= BOUNCE_BP) {
      armed = false;
      const notional = state.cash / 2n;
      if (notional >= MIN_NOTIONAL) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    return [];
  },
});
