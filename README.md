# btc-race-24h

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/dashaaa12/btc-race-24h/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/dashaaa12/btc-race-24h/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A patient trend-following bot for the cbBTC/USDC one-minute replay. Because a round trip on this thin pool costs roughly 30-35 bps in fees, slippage and price impact, the bot stays in cash unless a multi-hour uptrend is confirmed several times over — EMA regime, a trailing ~3.7-hour return of at least +80 bps, a non-falling last hour and no spent half-hour spike — then trades at full size capped to a small share of the pool depth, and exits on a trailing stop, a hard stop or a maximum hold.

## Run it

```sh
node cli/makefun.mjs grade-local --kit . --bot ~/workspace/makefun/btc-race-entry --driver process --worktree
```

(from the unpacked kit directory; `--driver docker` runs the same grade in the server's sandbox where Docker is available.)

---

<sub>Entered on [make.fun](https://make.fun/?ref=y1enas6g&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
