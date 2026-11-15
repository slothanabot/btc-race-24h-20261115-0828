# btc-race-24h-20261115-0828 — dip-bounce BTC bot

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828)

A bot for make.fun's [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261115-0828)
competition. It trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by
minute, on the published dev window.

## Strategy: dip-bounce with confirmation and staged exits

Bitcoin's sharp capitulation dips snap back. The bot:

1. **Arms** when the close falls at least 260 bp below the trailing 2-hour high.
2. **Confirms** the bounce: it only buys once the close has recovered at least
   40 bp off the dip low — the first sign the selling has stabilised, not the
   falling knife itself.
3. **Enters in two tranches**: half the cash on the confirmation, the rest if
   the price dips a further 40 bp below the first fill (a better average).
4. **Exits in stages**: sell half at +100 bp from the average fill, let the
   rest run to +400 bp or a 60 bp trailing stop (armed at +80 bp). The hard
   stop sits below the dip low (or 150 bp under the entry); once the first
   half is banked the stop on the remainder moves to breakeven. A position is
   given up after 240 bars, with a 20-bar cooldown after every exit.

## Result on the dev window

Local grade (`node cli/makefun.mjs grade-local --kit . --bot . --driver process`):
net PnL **+$37.74** on the dev window (buy-and-hold loses ~$40 there), 12 fills,
1.70% max drawdown, deterministic across two runs. The bot catches all three
of the window's capitulations, including the wash-out to 62,082 that rips to
65,480 (+547 bp in 76 minutes).

## Run

The entrypoint is `main.ts` (Node 22, erasable TypeScript). The kit's bars SDK
is vendored byte-identical under `vendor/`. No dependencies, no network, no
clock, no randomness — a pure function of the bars it is sent.
