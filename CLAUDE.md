# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Asset Hub ⇄ Hydration arbitrage bot (Polkadot). **It trades live with real funds; there is no paper mode.** Anything that runs `src/main.ts` signs and submits real transactions from the account in `ARB_MNEMONIC` (kept in `.env`, which is gitignored).

## Commands

```sh
npm install
npm start                          # node --no-opt --env-file-if-exists=.env --import tsx src/main.ts
npm test                           # vitest, specs only, no network
npx vitest run src/strategy.spec.ts            # one spec file
npx vitest run -t "size ladder"                # tests matching a name
npm run typecheck                  # tsc --noEmit
npm run preview                    # draw the live status once from fake data (no network); COLUMNS/LINES/ARB_ASCII vary it
```

- Always start through `npm start`. `--no-opt` works around a V8 optimizing-compiler crash under polkadot-api on Node 20/22. Running `src/main.ts` with plain `tsx` or `node` crashes.
- Exit code 2 means a deliberate halt (`Halt`). npm prints its own error lines after that, which is expected.
- Stop the bot with `touch data/STOP` (it halts at the next tick and refuses to start while the file exists), `ARB_KILL=1`, or Ctrl+C (finishes the current action; press twice to force).

## Architecture

Every tick in `main.ts` (`ARB_POLL_SECONDS`): read balances (`Book`) and USD prices on both chains → `planRebalance` (XCM only if a side is too thin to trade) → `findOpportunities` (plus the ETH watch, and a network-fee estimate every 10 min via `typicalXchainFees`) → `executeArb` on the single best candidate → update the live status.

- `strategy.ts` is **pure**. All quoting goes through the injected `Quoter` interface, so the specs drive it with fake quotes. It holds candidate search, the size ladder, `RESERVE` (per-chain balances never traded), and rebalance planning. Gross profit here already includes pool fees but **not** network fees.
- `executor.ts` adds the real network fees (`getEstimatedFees` on the actual txs), applies the profit floor, sets slippage limits, dry-runs, and sends. Every action runs inside `measured()`, which reads both chains' balances before and after and writes the delta, valued at the pre-action prices, to the ledger. Realized P&L is always measured, never taken from quotes. Errors whose message starts with `HALT:` inside `measured()` are turned into a `Halt`.
- `venues.ts`: Asset Hub `AssetConversion` (every pool pairs with DOT, so `ahPath` routes non-DOT pairs through DOT), the Asset Hub PSM (USDT ⇄ dotUSD), the Hydration router via `@galacticcouncil/sdk-next`, and the XCM builders (`transfer_assets_using_type_and_then`: LocalReserve AH→HY, DestinationReserve HY→AH, at most 2 assets per message, DOT first).
- `chains.ts`: connections, sr25519 key derivation, balances, prices, and `send` (always dry-run first, then sign).
- `dashboard.ts`: what the live status shows (`ui` state, the routes board, the charts, `renderLive()`). `main.ts` updates `ui`, calls `recordSample()` once per tick with every route's gross (from the `observe` callback of `findOpportunities`, plus the ETH watch), and copies its config into `settings`. `preview.ts` drives it with synthetic data. Use it to check layout changes; don't run the bot for that.
- `log.ts`: all output. On a TTY, `main.ts` registers `renderLive()` as a live region that redraws in place every second at the bottom of the screen. The bot runs on a Raspberry Pi and is watched over SSH. Normal log lines print above the region; while it is active, `console.log/error/warn` are wrapped so stray SDK output can't tear it. Off a TTY, or with `ARB_PLAIN=1`, every tick prints a plain line. Print through `log.*`, never with raw `process.stdout.write`. The charts in the region (`linePlot`, `barPlot`, sparklines) come from `chart.ts`, which is pure and has specs. Every printed line passes through `toAscii()` when `ARB_ASCII=1`, so a new symbol needs an entry in `TO_ASCII` in `log.ts`, or it prints as `?`.
- `pnl.ts`: `data/state.json` (running totals, baseline, `bootstrapped` flag) and `data/ledger.jsonl` (one line per action). Total P&L = arb + setup + rebalance + market. Delete both files to reset the baseline.
- `assets.ts`: asset IDs, locations and decimals (DOT 10, USDT/USDC/dotUSD 6, HDX 12). Amounts are `bigint` native units everywhere; convert with `native()` / `human()`.

First run (`bootstrap`): turns the USDT deposit into about equity/6 of each of DOT/USDT/USDC on each chain and sets Hydration's fee currency to DOT. It tops up only what is missing, so it is safe to restart midway.

## Trading strategies

Each trade is a closed round trip from inventory already held, so profit is taken in the same action. There is no position, take-profit or stop-loss.

| Kind | Mechanism | Atomic |
|---|---|---|
| `xchain` | Sell BASE for QUOTE on the dear chain and buy the same BASE back on the cheap chain, at the same time. All 6 ordered DOT/USDT/USDC pairs × 2 directions. Profit = leftover QUOTE. | No: two chains, two txs sent in parallel |
| `psm-mint` | USDT → PSM mint dotUSD (1:1 minus fee) → sell dotUSD on the AH pool. Pays when dotUSD > $1. | Yes, `utility.batch_all` |
| `psm-redeem` | Buy dotUSD on the AH pool → PSM redeem → USDT. Pays when dotUSD < $1. | Yes, `utility.batch_all` |

PSM is only one of the strategies, and on Asset Hub only (dotUSD is not registered on Hydration). The dotUSD pool path is dotUSD↔DOT↔USDT, two hops at 0.3 % each, so it needs roughly 0.6 % off peg.

### What decides whether a trade is taken

1. **Size search** (`sizeLadder`, `findOpportunities`): sizes `[1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20] × ARB_MIN_TRADE_USD`, capped at `ARB_MAX_TRADE_USD`. The walk stops at the first size that is unprofitable or can't be funded, and keeps the size with the highest gross.
2. **Profit floor** (`planXchain` / `planPsm`): execute only if `gross − estimated tx fees ≥ ARB_MIN_PROFIT_USD`.
3. **Slippage limits**: for `xchain`, each leg gets 40 % of the expected net as slack, so even if both legs fill at their worst price, 20 % of the net is kept. For PSM, the single swap gets 50 % of the net.

## Settings (env / `.env`, parsed in `main.ts` `config`)

| Variable | Default | Effect |
|---|---|---|
| `ARB_MNEMONIC` | required | Signing account |
| `ARB_DERIVATION` | `""` | Derivation path |
| `ARB_MIN_PROFIT_USD` | `0.01` | Net profit after tx fees needed to execute |
| `ARB_MIN_TRADE_USD` | `1` | First ladder step. Also the rebalance trigger (a side under 1.5× this) and the startup funding check (needs ≥ 2×) |
| `ARB_MAX_TRADE_USD` | `5` | Largest trade size |
| `ARB_MAX_DAILY_LOSS_USD` | `2` | Halt when arb+rebalance P&L for the UTC day reaches −this |
| `ARB_POLL_SECONDS` | `12` | Tick interval |
| `ARB_SUMMARY_EVERY` | `25` | Print the P&L table every N idle ticks |
| `ARB_ASSETHUB_RPC` / `ARB_HYDRATION_RPC` | public endpoints | RPCs |
| `ARB_DATA_DIR` | `./data` | Ledger, state and the `STOP` file |
| `ARB_KILL` | — | `1` = refuse to run |
| `ARB_PLAIN` | — | `1` = no live status region (plain line per tick) |
| `ARB_CHART_MINUTES` | `5` | History window of the live charts (`chart.ts`); `0` hides them |
| `ARB_CHART_HEIGHT` | `8` | Rows for the price plot; shrinks to fit the terminal, `1` = one-line sparklines |
| `ARB_ASCII` | — | `1` = ASCII only (fonts in PuTTY/mRemoteNG show boxes for block/box/braille glyphs) |
| `ARB_BOARD_ROWS` | `5` | Routes on the board; `0` hides it |
| `ARB_WATCH_ETH` | on | `0` = stop quoting the ETH/DOT route |

Hard-coded values that may also need tuning: `MAX_FAILED_IN_A_ROW = 3` (`main.ts`), `RESERVE` and the ladder steps (`strategy.ts`), the 40/40/20 and 50/50 slippage splits and the 10-minute XCM arrival timeout (`executor.ts`).

## Gotchas

- There is no `.env.example`. The settings tables here and in the README are the reference, so keep them in sync with `config` in `main.ts`.
- `ARB_MAX_TRADE_USD` is effectively capped by inventory. Each chain holds about equity/6 per asset minus `RESERVE`, and the ladder stops at the first size it can't fund.
- Read chain state with `BEST` (`{ at: 'best' }`, from `chains.ts`): runtime calls, storage queries and `DryRunApi`. polkadot-api defaults to the finalized block, which was 12 blocks behind best when checked. Quoting from there produced swaps that failed on chain with `AssetConversion.ProvidedMinimumNotSufficientForSwap`.
- ETH is **watch only** (`watchEth` in `strategy.ts`, `ethQuoter` in `venues.ts`, `ETH` in `assets.ts`). It isn't in `Sym`/`SYMS`, so the book, bootstrap, rebalancing and XCM don't know about it. Trading it would need inventory on both chains and the XCM paths for a Snowbridge asset verified by dry run first.
- Keep `strategy.ts` free of network calls so the specs stay offline. New quoting needs go on `Quoter`.
- When selling an entire balance on Asset Hub (e.g. freshly minted dotUSD), `ahSwapIn` needs `keepAlive = false`, or the pallet fails with `Token.NotExpendable`.
- Chain facts (asset IDs, PSM fees, XCM transfer types) were verified on chain on 2026-11-03. See the README section "Chain facts this relies on" before changing XCM or asset config.
