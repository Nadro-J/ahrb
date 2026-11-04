# arb: Asset Hub ⇄ Hydration arbitrage bot

A small bot that trades **live** with real funds. There is no paper mode. It
signs with a mnemonic, keeps inventory on both chains, and only trades when a
trade still clears every fee.

```sh
# once, from the repo root
npm install

# run (or put ARB_MNEMONIC in ../.env)
ARB_MNEMONIC="word1 word2 … word12" npm start
```

`npm start` runs `node --no-opt`. Without that flag, V8's optimizing compiler
crashes under polkadot-api on Node 20/22 ("Fatal error … unreachable code" in
`turboshaft::BuildGraph`), the same bug the server works around (see
`docs/runbook.md`). Don't run `src/main.ts` with plain `tsx` or `node`. When
the bot halts (exit code 2), npm also prints its own "npm error" lines; that's
expected.

Fund the account with USDT on **Polkadot Asset Hub** first, e.g. 40 USDT. The
address is printed at startup, and it is the same account your wallet
extension shows for that mnemonic (sr25519, no derivation path unless you set
`ARB_DERIVATION`).

## What it does

**1. Setup (first run only).** It turns the deposit into even inventory: about
1/6 of the equity in each of DOT, USDT and USDC on each chain. It buys DOT and
USDC on Asset Hub (the first swap pays its fee in USDT, because the account
holds no DOT yet), sends half of each asset to Hydration over XCM, and sets
Hydration's fee currency to DOT. Setup tops up only what is missing, so it is
safe to restart midway.

**2. Every tick (12 s).** It reads balances and prices on both chains and
quotes every candidate:

| Loop | What happens | Atomic? |
|---|---|---|
| **xchain** | Sell X for Y on the chain where X is dear and buy the same X back with Y where it is cheap, at the same time, from inventory on both chains. All six ordered pairs of DOT/USDT/USDC in both chain directions. The profit is the Y left over. | No. Both legs are dry-run first, then submitted together. Each leg's slippage limit is set so the pair still breaks even if both fill at their worst price. |
| **psm-mint** | USDT → PSM mint → dotUSD → sell on the pool for USDT (when dotUSD trades above $1) | Yes, one `utility.batch_all` |
| **psm-redeem** | USDT → buy dotUSD on the pool → PSM redeem → USDT (when dotUSD trades below $1) | Yes, one `utility.batch_all` |

The search starts at the minimum size and walks up a size ladder ($1 … $5) for
as long as the profit grows. For the best candidate it estimates the real
network fees of the actual transactions. It executes only if
**gross − fees ≥ `ARB_MIN_PROFIT_USD`**. Every transaction is dry-run on chain
before it is signed.

**3. Rebalancing.** When trades leave one side of an asset too thin to fund a
minimum trade (under 1.5 × min size), it sends that asset back to a 50/50 split
over XCM. It moves inventory only when it has to, because each XCM costs about
$0.03.

## P&L

Every action is **measured**, not estimated. The bot reads balances on both
chains before and after the action and values the difference at the prices from
before it. That gives what the action really earned or cost, with every fee
included (pool, PSM, tx fees on both chains, XCM delivery and execution) and
market moves left out.

```
  Equity $39.71 (DOT $0.9286)  P&L -$0.29 = arb +$0.03 · setup -$0.24 · rebalance -$0.03 · market -$0.05
```

- **total**: equity now minus equity at the first funded run (the baseline)
- **arb**: the measured result of every arb, including failed ones
- **setup / rebalance**: what inventory management cost
- **market**: the rest, i.e. holding DOT while its price moves

`arb/data/state.json` holds the running totals. `arb/data/ledger.jsonl` has one
line per action: the expected and realized amounts, the tx hashes, and the
balances before and after. Delete both files to start a fresh baseline.

## Stopping

- **Ctrl+C**: finishes the current action, prints the final table, then exits.
  Press it twice to force.
- **Kill switch**: `touch arb/data/STOP` (the bot halts at the next tick and
  refuses to start while the file exists), or `ARB_KILL=1`.
- **Automatic halts**: the daily loss limit (`ARB_MAX_DAILY_LOSS_USD`, counting
  arbs and rebalances in the current UTC day), 3 failed arbs in a row, or an XCM
  that has not arrived after 10 minutes.

## Settings

All settings come from the environment (or `.env`). The full list with
defaults is in the root `.env.example` under "Arb bot".

## Expect it to sit idle

When this was written, Asset Hub DOT/USDT was at $0.9286. Hydration quoted
$0.9263 to sell 2 DOT and $0.9321 to buy 2 DOT. A cross-chain round trip pays
about 0.3 % on Asset Hub plus Hydration's route fee, so it needs a spread above
roughly 0.6–0.8 %. The PSM loop needs dotUSD more than about 0.6 % off peg,
because it crosses two pool hops through DOT. Spreads that large are rare, and
the bot correctly does nothing most of the time. Raising `ARB_MAX_TRADE_USD`
lets it take more of a spread when one shows up. Lowering `ARB_MIN_PROFIT_USD`
does not create trades: the hard floor is still "net > fees".

## Chain facts this relies on (verified 2026-11-03)

- Asset Hub: USDT = Assets 1984, USDC = 1337, dotUSD = 7873 (PSM internal
  asset, external: USDT only, mint fee 0 %, redeem fee 0.01 %, min swap 1).
  Every pool pairs with DOT.
- Hydration: DOT = 5, USDT = 10, USDC = 22. dotUSD is not registered, so PSM
  legs stay on Asset Hub.
- XCM: `PolkadotXcm.transfer_assets_using_type_and_then`. Asset Hub → Hydration
  uses LocalReserve and Hydration → Asset Hub uses DestinationReserve, with at
  most 2 assets per message. Both directions were dry-run end to end for every
  asset (source `dry_run_call`, then destination `dry_run_xcm`). Plain
  `transfer_assets` refuses DOT (`InvalidAssetUnknownReserve`).

## Code

| File | |
|---|---|
| `src/main.ts` | config, the loop, the status output |
| `src/strategy.ts` | candidate search, sizing, rebalance planning (pure; specs use fake quotes) |
| `src/executor.ts` | setup, arb execution with limits, XCM with arrival tracking, measured actions |
| `src/venues.ts` | Asset Hub pools + PSM, Hydration router, XCM builders |
| `src/chains.ts` | connections, key, balances, prices, dry-run-then-send |
| `src/pnl.ts` | ledger and P&L split |

`npm test` runs the specs (no network).
