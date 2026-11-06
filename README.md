# arb: Asset Hub ⇄ Hydration arbitrage bot

A small bot that trades **live** with real funds. There is no paper mode. It
signs with a mnemonic, keeps inventory on both chains, and only trades when a
trade still clears every fee.

```sh
# once
npm install

# run (or put ARB_MNEMONIC in .env)
ARB_MNEMONIC="word1 word2 … word12" npm start
```

`npm start` runs `node --no-opt`. Without that flag, V8's optimizing compiler
crashes under polkadot-api on Node 20/22 ("Fatal error … unreachable code" in
`turboshaft::BuildGraph`). Don't run `src/main.ts` with plain `tsx` or `node`. When
the bot halts (exit code 2), npm also prints its own "npm error" lines; that's
expected.

Fund the account with USDT on **Polkadot Asset Hub** first, e.g. 40 USDT. The
address is printed at startup, and it is the same account your wallet
extension shows for that mnemonic (sr25519, no derivation path unless you set
`ARB_DERIVATION`).

## How it works (picture version)

The bot keeps a little of each coin on both chains. When the same coin is
cheaper on one chain than on the other, it sells where it's dear and buys back
where it's cheap, both at once. It ends up holding the same coins plus a few
cents.

```mermaid
sequenceDiagram
    participant AH as Asset Hub
    participant Bot as Bot (your account)
    participant HY as Hydration
    Note over AH,HY: Example: DOT is $0.960 on Asset Hub and $0.945 on Hydration
    par at the same time
        Bot->>AH: sell 2 DOT (dear here)
        AH-->>Bot: 1.92 USDT
    and
        Bot->>HY: pay 1.89 USDT
        HY-->>Bot: 2 DOT (cheap here)
    end
    Note over Bot: still 2 DOT on each side, plus 0.03 USDT
    Bot-->>HY: XCM top-up, only when one side runs low (about $0.03)
```

Result: 1.92 − 1.89 = **0.03 USDT** profit before network fees.

### Every tick

```mermaid
flowchart TD
    A(["tick: every ARB_POLL_SECONDS"]) --> K{"STOP file, daily loss limit<br/>or an XCM stuck 10 min?"}
    K -- yes --> H(["halt (exit 2)"])
    K -- no --> B["read balances and prices on both chains"]
    B --> R{"a side too thin to trade?<br/>(under 1.5 × ARB_MIN_TRADE_USD)"}
    R -- yes --> X["XCM: move it back to a 50/50 split"] --> Q
    R -- no --> Q["quote every candidate:<br/>24 cross-chain + PSM mint/redeem<br/>(routes paused after a failure are skipped)<br/>at sizes $1, $1.5, $2 … up to ARB_MAX_TRADE_USD"]
    Q --> G{"best gross profit > 0?<br/>(pool fees already included)"}
    G -- no --> W["wait (the status line shows the nearest trade)"]
    G -- yes --> F{"gross − network fees<br/>≥ ARB_MIN_PROFIT_USD?"}
    F -- no --> W
    F -- yes --> D["dry-run both legs, then send them together<br/>with slippage limits"]
    D --> M["measure balances before vs after → ledger<br/>(a failure is counted by error and its route paused)"]
    M --> W
    W --> A
```

### When a trade is worth it

Each check has to pass before anything is sent:

```mermaid
flowchart LR
    S["price gap between chains"] -->|"minus pool fees<br/>(~0.3 % each swap)"| G["gross"]
    G -->|"minus network fees<br/>(both chains)"| N["net"]
    N -->|"must be ≥ ARB_MIN_PROFIT_USD<br/>($0.01 by default)"| T["trade"]
    T -->|"slippage limits keep<br/>at least 20 % of net"| P["worst case: ≥ $0.002"]
```

Spreads big enough to pass are rare, so expect the bot to sit idle most of the
time (see [Expect it to sit idle](#expect-it-to-sit-idle)).

## What it does

**1. Setup (first run only).** It turns the deposit into even inventory: about
1/8 of the equity in each of DOT, USDT, USDC and ETH on each chain. It buys
DOT, USDC and ETH with USDT on Asset Hub (the first swap pays its fee in USDT,
because the account holds no DOT yet), sends half of each asset to Hydration
over XCM, and sets Hydration's fee currency to DOT. Setup tops up only what is
missing, so it is safe to restart midway. An asset added later (ETH, for an
account set up before it was added) is set up on its own at the next start,
using only the USDT the account can spare.

**2. Every tick (12 s).** It reads balances and prices on both chains and
quotes every candidate:

| Loop | What happens | Atomic? |
|---|---|---|
| **xchain** | Sell X for Y on the chain where X is dear and buy the same X back with Y where it is cheap, at the same time, from inventory on both chains. All twelve ordered pairs of DOT/USDT/USDC/ETH in both chain directions. The profit is the Y left over. | No. Both legs are dry-run first, then submitted together. Each leg's slippage limit is set so the pair still breaks even if both fill at their worst price. |
| **psm-mint** | USDT → PSM mint → dotUSD → sell on the pool for USDT (when dotUSD trades above $1) | Yes, one `utility.batch_all` |
| **psm-redeem** | USDT → buy dotUSD on the pool → PSM redeem → USDT (when dotUSD trades below $1) | Yes, one `utility.batch_all` |

The PSM loops run in their own **fast lane**: on every new Asset Hub block
(about every 2–3 s), not every tick, because other traders work the same
pool and the first one in takes the gap. They size up to
`ARB_PSM_MAX_TRADE_USD` ($25), separately from the cross-chain cap. They are
atomic, need only USDT on Asset Hub, and the dotUSD/DOT pool is deep (about
$88k on 2026-11-06; $50 costs only ~0.1 % more than $1). **The USDT on Asset
Hub is the real limit on PSM size**, so keep some there (see
[dotUSD](#dotusd)). Only one action runs at a time: the fast lane waits for
the tick's trade and the other way round.

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

P&L is reported **by time**: for each session (one run of the bot, from start
to stop) and for rolling windows (last 1h, 12h, 24h, 7d), each split in two:

- **trading**: what the bot's own actions made: arbs (failed ones included),
  setup and rebalances. This is the number that says whether the bot works.
- **market**: everything else the equity did, i.e. holding DOT and ETH while
  their prices move. With about half the inventory in DOT and ETH, this is
  usually much bigger than trading, in either direction.
- **total** = trading + market. Deposits recorded with `npm run deposit` are
  left out.

The live status shows the session and the last 24h. `npm run pnl` prints the
windows, the last sessions and each day, from the data files alone. An
example (the Pi's trades with made-up sessions and snapshots):

```
P&L  (trading = what the bot's actions made; market = holding the coins; total = both)

Rolling windows to 2026-11-06 11:50 (last snapshot, equity $49.59)
  window                    trading        arb  rebalance     market      total
  last 1h                  +$0.0183   +$0.0218   -$0.0035   -$0.0283   -$0.0100   1 arbs, 1 profitable, 0 failed
  last 12h                 +$0.0183   +$0.0218   -$0.0035   -$0.4883   -$0.4700   1 arbs, 1 profitable, 0 failed
  last 24h                 +$0.0171   +$0.0206   -$0.0035   -$0.5171   -$0.5000   1 arbs, 1 profitable, 4 failed
  last 7d (partial)        +$0.0273   +$0.0308   -$0.0035          ?          ?   2 arbs, 2 profitable, 5 failed

Sessions (each run of the bot; last 2 of 2)
  started · ran for         trading        arb  rebalance     market      total
  11-04 19:00 · 19h00m     +$0.0090   +$0.0090    $0.0000   -$0.3090   -$0.3000   1 arbs, 1 profitable, 5 failed
  11-06 09:30 · 2h30m      +$0.0183   +$0.0218   -$0.0035   -$0.2183   -$0.2000   1 arbs, 1 profitable, 0 failed

Days (UTC)
  day                       trading        arb  rebalance     market      total
  2026-11-04 (partial)     -$0.0015   -$0.0015    $0.0000          ?          ?   0 arbs, 0 profitable, 1 failed
  2026-11-05               +$0.0104   +$0.0104    $0.0000   -$0.0504   -$0.0400   1 arbs, 1 profitable, 4 failed
  2026-11-06               +$0.0183   +$0.0218   -$0.0035   -$0.4883   -$0.4700   1 arbs, 1 profitable, 0 failed

  all time: trading +$0.0273 since 2026-11-04 09:23 · baseline $50.19 (incl. 1 deposit)
```

`partial` means the window starts before the first equity snapshot, so only
trading is known. Files in `data/`:

- `ledger.jsonl`: one line per action, with the expected and realized
  amounts, the tx hashes, and the balances before and after
- `equity.jsonl`: equity every 10 minutes while the bot runs (the start of
  each rolling window)
- `state.json`: the sessions, the deposits, the all-time totals and the error
  counts

Delete all three to start fresh.

## Stopping

- **Ctrl+C**: finishes the current action, prints the final table, then exits.
  Press it twice to force. `SIGTERM` (e.g. `systemctl stop`) and `SIGHUP` (the
  terminal closing) stop it the same way.
- **Kill switch**: `touch data/STOP` (the bot halts at the next tick and
  refuses to start while the file exists), or `ARB_KILL=1`.
- **Automatic halts**: the daily loss limit (`ARB_MAX_DAILY_LOSS_USD`, counting
  arbs and rebalances in the current UTC day) or an XCM that has not arrived
  after 10 minutes. Failed trades do **not** stop the bot (see
  [Errors](#errors)).

## Errors

A failed trade is logged, counted and kept running past:

- The ledger counts every failure by kind, stage and error name (e.g.
  `AssetConversion.ProvidedMinimumNotSufficientForSwap`), with its measured
  cost. The live status shows the two most frequent.
- **dry-run** failures sent nothing and cost nothing. **on-chain** failures
  were included in a block and paid their fees.
- The route that failed is paused: 1 minute after the first failure, doubling
  with each failure in a row up to 30 minutes, cleared by a success. A broken
  route can't burn fees every tick, and the other routes keep trading. The
  daily loss limit is the backstop.
- `npm run errors` lists every failure group (count, cost, first and last time,
  the last message in full) and the most recent failures, from the ledger
  alone. `npm run errors -- 30` shows the last 30.

## Settings

All settings come from the environment (or `.env`):

| Variable | Default | |
|---|---|---|
| `ARB_MNEMONIC` | required | signing account |
| `ARB_DERIVATION` | none | derivation path |
| `ARB_MIN_PROFIT_USD` | `0.01` | net profit after tx fees needed to trade |
| `ARB_MIN_TRADE_USD` | `1` | smallest trade; also the rebalance trigger (a side under 1.5×) |
| `ARB_MAX_TRADE_USD` | `5` | largest trade; capped in practice by the inventory on each chain |
| `ARB_MAX_DAILY_LOSS_USD` | `2` | halt when arbs + rebalances lose this much in a UTC day |
| `ARB_POLL_SECONDS` | `12` | time between checks |
| `ARB_SUMMARY_EVERY` | `25` | plain mode only: print the balance table every N idle ticks |
| `ARB_ASSETHUB_RPC` / `ARB_HYDRATION_RPC` | public endpoints | RPC URLs |
| `ARB_DATA_DIR` | `./data` | ledger, state and the `STOP` file |
| `ARB_KILL` | none | `1` refuses to run |
| `ARB_PLAIN` | none | `1` turns off the live status lines |
| `ARB_CHART_MINUTES` | `5` | how much history the live charts show; `0` hides them |
| `ARB_CHART_HEIGHT` | `8` | rows for the price chart (the trade chart gets ~60 %); `1` = one-line sparklines |
| `ARB_ASCII` | none | `1` prints plain ASCII only, for fonts that show boxes |
| `ARB_BOARD_ROWS` | `5` | routes shown on the board; `0` hides it |
| `ARB_PSM_MAX_TRADE_USD` | `25` | largest PSM trade (also limited by the USDT on Asset Hub) |
| `ARB_PSM_FAST` | on | `0` checks the PSM once per tick instead of on every Asset Hub block |

## Screen output

On a terminal, the bottom of the screen is a live status that redraws in
place every second instead of printing a line every tick:

```
● LIVE #150 up 15m · DOT $0.9531 AH / $0.9524 HY (-0.07%) · next check 4s
  nearest trade -$0.0035 psm-mint · best since start +$0.0021 at 14:02 · dotUSD 0.9951/1.0071
  session 3h15m  trading +$0.0183 (2 arbs, 1 failed) · market -$0.21
  last 24h  trading +$0.0337 (3 arbs, 4 failed) · market -$0.52 · equity $40.12 · today  $0.00 (halt at −$2) · last trade 13:40 ok
  errors 3× AssetConversion.ProvidedMinimumNotSufficientForSwap (on-chain -$0.011) · 1× Token.FundsUnavailable (dry-run) · npm run errors
  routes gross now · last 15m · best
  -$0.0054  ETH/DOT sell HY→buy AH    ▁▁▁▁▃▅▇█▇▅▃▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▂▅▇█▇▅▃▂  best +$0.0060
  -$0.0062  USDT/USDC sell AH→buy HY  ▃▃▄▄▄▅▅▅▅▅▄▄▄▃▃▃▂▂▂▁▁▁▁▁▁▁▂▂▃▃▃▄▄▄▅▅▅▅▅▄▄  best -$0.0050
  -$0.0087  DOT/USDT sell AH→buy HY   ▄▄▅▅▅▆▆▅▅▅▄▃▃▂▂▁▁▁▁▂▂▃▃▄▄▅▅▆▆▅▅▅▄▄▃▂▂▁▁▁▁  best -$0.0030  paused 3m
  -$0.0090  ETH/DOT sell AH→buy HY    ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁  best -$0.0090
  -$0.0130  DOT/USDC sell HY→buy AH   ▂▃▃▃▃▃▃▄▄▄▄▄▄▄▄▄▃▃▃▃▃▂▂▂▂▂▂▁▁▁▁▁▁▁▁▁▁▁▂▂▂  best -$0.0090
  dotUSD on the AH pool, USDT each · ● sell (mint pays above $1) ● buy (redeem pays below $1)
   $1.0101 ┤                ●●●●●●●●●                                     ●●●
           ┤●●●●●●●●●●●●●●●●         ●●●●●●●●●●●●●●●●●                   ●   ●             ●●●●
           ┤                                          ●●●●●●●●●●●●●●●●●●●     ●●●●●●●●●●●●●
   $1.0024 ┤
   $1.0000 ┤┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
           ┤        ●●●●●●●●●●●●●●●●●●●●●●●●●                             ●●●
           ┤●●●●●●●●                         ●●●●●●●●●●●●●●              ●   ●        ●●●●●●●●●
   $0.9920 ┤                                               ●●●●●●●●●●●●●●     ●●●●●●●●
           └───────────────────────────────────────────────────────────────────────────────────
            -15m                                                                            now
  nearest trade gross, before network fees · cross-chain trades above +$0.014 (fees + min profit)
   +$0.006 ┤             ████                                                       ████
           ┤            ███████                                                    ███████
    $0.000 ┤┄┄┄┄┄┄┄┄┄┄┄█████████┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄█████████┄┄┄┄
           ┤███████████         ██████████████████████████████████████████████████         ████
   -$0.006 ┤████                   ██████████████████████████                ██               █
           └───────────────────────────────────────────────────────────────────────────────────
            -15m                                                                            now
  DOT price   ● Asset Hub   ● Hydration   ◆ both
   $0.9532 ┤         ●●●◆◆◆◆◆◆●●●●●●●●
           ┤      ◆◆◆●●●      ●●●     ●●●●●                                                ●●●●
           ┤  ●●◆◆               ●●●       ●●●●●                                       ●●●●
   $0.9519 ┤●●●●                    ●●          ●●●●                              ●●●●●      ●●
           ┤●●                        ●●●           ●●●●●                     ●●●●         ●●
           ┤                             ●●●●          ●●◆◆◆◆◆◆◆◆◆◆●◆●●●●●●●●●          ●●●
           ┤                                 ●●●●●●●●●●            ● ●●●●●●          ●●●
   $0.9501 ┤                                                               ●●●●●●●●●●
           └───────────────────────────────────────────────────────────────────────────────────
            -15m                                                                            now
```

How to read it (newest on the right):

- **session / last 24h**: P&L split into trading (what the bot made) and
  market (holding the coins). See [P&L](#pl).
- **dotUSD** (on the status line and the first chart): what selling dotUSD on
  the Asset Hub pool fetches (green, `o`) and what buying it costs (magenta,
  `x`), against the dotted $1 line. Mint pays when the sell price climbs above
  $1 by more than fees; redeem pays when the buy price drops below $1.
- **routes**: every route the bot quotes, closest to profitable first. Each
  row shows the gross now, a sparkline of the window, and the best in the
  window. Bars are green above $0 and yellow once they clear the "needed"
  line, where a trade goes ahead. A route paused after a failure says
  `paused Nm`.
- **nearest trade**: the best route's gross profit each tick, as bars around
  the $0 line. The title gives what a cross-chain trade needs: the network
  fees of a typical round trip (estimated every 10 minutes from real
  transactions, nothing sent) plus `ARB_MIN_PROFIT_USD`.
- **DOT price**: DOT on both chains on one shared scale, shown when the
  window is tall enough.
- **errors**: the two most frequent failures, with their stage and cost
  (shown only once something has failed).

`npm run preview` draws this screen once from made-up data, without
connecting to anything. Try `COLUMNS=60 LINES=24 npm run preview` or
`ARB_ASCII=1 npm run preview` to see other sizes and modes.

The board and charts shrink to fit the window. With little room the charts
turn into one-line sparklines, and if even that doesn't fit they are hidden. Set
`ARB_CHART_HEIGHT=1` to always use sparklines, or a higher number for taller
charts.

### Boxes instead of symbols (PuTTY, mRemoteNG)

If the charts show as empty squares, the terminal's font lacks those
characters. Either:

- **Fix the font** (recommended). In mRemoteNG: *Tools → Options → Advanced →
  Launch PuTTY*, load the session that mRemoteNG uses (*Default Settings*
  unless you set one), then set *Window → Appearance → Font* to **Consolas**
  or **Cascadia Mono** and *Window → Translation → Remote character set* to
  **UTF-8**. Click *Save*.
- **Or use a better client**: Windows Terminal (built into Windows 11, and in
  the Store for 10) renders everything out of the box: `ssh pi@raspberrypi.local`.
- **Or set `ARB_ASCII=1`**, which draws everything with plain ASCII
  (`o`/`x` points, `#` bars, `|` and `-` axes) and works in any font.

When stdout is not a terminal (a log file, systemd/journald) or `ARB_PLAIN=1`,
it prints one line per tick, as before.

## Running on a server (e.g. a Raspberry Pi over SSH)

The bot runs in a **tmux** session, so it keeps going when you disconnect and
you can attach to the live dashboard whenever you SSH in. **systemd** starts
that session at boot, and `scripts/run-forever.sh` restarts the bot after a
crash. It does **not** restart after a halt (daily loss limit, an XCM that
didn't arrive, `data/STOP`) or a stop you asked for: those want a look first.

### One-time setup on the Pi

```sh
sudo apt install tmux
cd ~/ahrb && npm install       # .env with ARB_MNEMONIC (and your settings) next to package.json
which node                     # note where node lives
```

Edit `scripts/arb.service`: `User`, the three `/home/pi/ahrb` paths, and
`PATH`. If `which node` printed something under `~/.nvm/...`, put that `bin`
directory first, e.g.
`Environment=PATH=/home/pi/.nvm/versions/node/v20.18.0/bin:/usr/local/bin:/usr/bin:/bin`.
Then:

```sh
sudo cp scripts/arb.service /etc/systemd/system/arb.service
sudo systemctl daemon-reload
sudo systemctl enable --now arb      # starts now and at every boot
```

### Checking in

```sh
ssh pi@raspberrypi.local
tmux attach -t arb        # the live dashboard. Leave with Ctrl+B then D, NOT Ctrl+C (that stops the bot)
npm run pnl               # P&L by session, window and day (no need to attach)
npm run errors            # what has failed
tmux capture-pane -pt arb # print the current screen without attaching
systemctl status arb      # is it running?
cat data/runs.log         # every start, crash, halt and stop, with its exit code
```

### If `tmux attach` says "no sessions"

The bot stopped, or never started, and the session closed with it. Check:

```sh
tail data/runs.log                 # why it stopped: exit 2 = halted, 0 = stopped
journalctl -u arb -n 30            # what systemd saw
./scripts/run-forever.sh           # run it in the foreground to see any error (Ctrl+C to stop)
```

A service that lasts only milliseconds means the script itself didn't run:
a wrong path in `arb.service`, or Windows line endings (`file
scripts/run-forever.sh` says "CRLF"; fix with `sed -i 's/\r$//'
scripts/run-forever.sh`).

### Stopping, updating, restarting

```sh
sudo systemctl stop arb               # graceful: finishes the current step, then exits
git pull && npm install               # update
sudo systemctl start arb
```

After a halt, the session is gone and the service shows as inactive. Look at
why (`npm run errors`, the last lines of `data/ledger.jsonl`), fix it,
remove `data/STOP` if you used it, then `sudo systemctl start arb`. To record
funds you added, stop it first, then `npm run deposit -- <usd>`, then start
it.

Without systemd, `tmux new -s arb` then `scripts/run-forever.sh` (or
`npm start`) does the same until the Pi reboots. The bot warns at startup if
it runs over SSH outside tmux or screen, because closing the SSH session
would then stop it.

## ETH

ETH (Snowbridge ether) trades like the other assets. On Asset Hub it is a
ForeignAssets asset with its own DOT/ETH pool, which is small (about $4.6k on
2026-11-04): 0.34 % to swap $1, 0.51 % for $5. So prices there move fast, and
only small sizes pay. On Hydration it is asset 34, routed through the Aave
money market.

- Setup buys it with USDT (USDT → DOT → ETH on Asset Hub) and sends half to
  Hydration. An account set up before ETH was added gets it at the next start,
  using only spare USDT on Asset Hub. To fully stock it, add USDT first and
  record the deposit (see [Adding funds](#adding-funds)).
- **ETH always travels in its own XCM message.** Its paths were verified
  (`npm run verify-xcm -- ETH`, 2026-11-05) in both directions as a
  single-asset message, paying its own destination fee in ETH. ETH paired with
  DOT could not be checked from Hydration.
- Reserve kept back: 0.00003 ETH on Asset Hub, 0.000011 on Hydration (twice
  each chain's existential deposit).

## dotUSD

dotUSD is Asset Hub's PSM stablecoin: the PSM swaps USDT for dotUSD 1:1
(mint fee 0 %, redeem fee 0.01 % on 2026-11-06), while the pool prices it
against DOT. When the pool drifts off $1, the bot buys on one side and sells
on the other in one atomic batch:

- **mint** when the pool pays more than $1 for dotUSD: USDT → PSM → dotUSD →
  pool → USDT.
- **redeem** when the pool sells dotUSD for less than $1: USDT → pool →
  dotUSD → PSM → USDT.

The pool path is dotUSD ⇄ DOT ⇄ USDT (no direct dotUSD/USDT or dotUSD/USDC
pool exists, and Hydration doesn't list dotUSD), two hops at 0.3 % each. So a
loop needs the pool about 0.6 % off peg. On 2026-11-06 it quoted 0.9950 to
sell and 1.0071 to buy. The first PSM trade on the Pi (a $5 mint) made
+$0.0117.

To give it room, keep USDT on Asset Hub beyond the even split. A deposit
there stays there: rebalancing only moves an asset when one side can't fund a
minimum trade.

## Adding funds

Send USDT to the account on Asset Hub, then, with the bot stopped:

```sh
npm run deposit -- 10     # the USD you added (negative for a withdrawal)
npm start
```

`deposit` raises the P&L baseline, so the new money isn't counted as profit.
At start the bot sets up any asset it holds too little of.

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
- Reads (quotes, balances, PSM state, dry runs) target the **best** block, not
  the finalized one that polkadot-api uses by default. Finalized was 12 blocks
  behind best when checked. Quotes from there show spreads that someone has
  already closed, and the swap then fails on chain with
  `AssetConversion.ProvidedMinimumNotSufficientForSwap` (the slippage limit),
  paying its fee.
- Asset Hub ETH: ForeignAssets, location `{ parents: 2, GlobalConsensus(Ethereum { chain_id: 1 }) }`, min balance 0.000015.
- Hydration: DOT = 5, USDT = 10, USDC = 22, ETH = 34 (existential deposit 0.0000054). dotUSD is not registered, so PSM
  legs stay on Asset Hub.
- XCM: `PolkadotXcm.transfer_assets_using_type_and_then`. Asset Hub → Hydration
  uses LocalReserve and Hydration → Asset Hub uses DestinationReserve, with at
  most 2 assets per message, and ETH on its own. Both directions were dry-run
  end to end for every asset (source `dry_run_call`, then destination
  `dry_run_xcm`); `npm run verify-xcm -- <ASSET>` repeats that check. Plain
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
| `src/log.ts`, `src/chart.ts` | output, the live region mechanics, plots and sparklines |
| `src/dashboard.ts`, `src/preview.ts` | what the live status shows; `npm run preview` draws it from fake data |
| `src/errors.ts` | `npm run errors`: failures from the ledger |
| `src/periods.ts`, `src/pnl-report.ts` | P&L by session and time window; `npm run pnl` |
| `src/deposit.ts` | `npm run deposit -- <usd>`: record funds added or taken out |
| `scripts/run-forever.sh`, `scripts/arb.service` | keep it running on a server: restart after crashes, start at boot in tmux |
| `src/verify-xcm.ts` | `npm run verify-xcm -- <ASSET>`: read-only dry runs of every XCM path |

`npm test` runs the specs (no network).
