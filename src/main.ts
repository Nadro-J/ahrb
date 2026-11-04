/**
 * Asset Hub ⇄ Hydration arbitrage bot. Runs live with real funds — there is
 * no paper mode.
 *
 *   ARB_MNEMONIC="word1 … word12" npm start -w arb
 *
 * Every tick: read balances and prices on both chains, quote every candidate
 * (cross-chain DOT/USDT/USDC spreads and the Asset Hub PSM peg), and execute
 * the best one only if it is still profitable after every fee. XCM moves
 * inventory between the chains only when a side runs too low to trade.
 *
 * Stops on: Ctrl+C (finishes the current action first), the kill switch
 * (ARB_KILL=1 or a file named STOP in the data dir), the daily loss limit,
 * 3 failed arbs in a row, or an XCM that never arrives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_NAME, human, SYMS, type Chain } from './assets.js';
import { connect, readBook, readPrices, sleep, usdOf, walletFromMnemonic, type Book, type Prices } from './chains.js';
import { bootstrap, dotPrices, ensureHydrationFeeCurrency, executeArb, Halt, rebalance, type Ctx } from './executor.js';
import { c, log, usd, usdColored } from './log.js';
import { Ledger } from './pnl.js';
import { describe, findOpportunities, planRebalance, type Limits, type Quoter } from './strategy.js';
import { ahQuoteIn, ahQuoteOut, hyBuy, hySell, psmState } from './venues.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${v}"`);
  return n;
};

const config = {
  mnemonic: process.env.ARB_MNEMONIC ?? '',
  derivation: process.env.ARB_DERIVATION ?? '',
  ahRpc: process.env.ARB_ASSETHUB_RPC ?? 'wss://polkadot-asset-hub-rpc.polkadot.io',
  hyRpc: process.env.ARB_HYDRATION_RPC ?? 'wss://hydration-rpc.n.dwellir.com',
  dataDir: process.env.ARB_DATA_DIR ?? path.resolve(here, '../data'),
  minTradeUsd: num('ARB_MIN_TRADE_USD', 1),
  maxTradeUsd: num('ARB_MAX_TRADE_USD', 5),
  minProfitUsd: num('ARB_MIN_PROFIT_USD', 0.01),
  maxDailyLossUsd: num('ARB_MAX_DAILY_LOSS_USD', 2),
  pollSeconds: num('ARB_POLL_SECONDS', 12),
  summaryEvery: num('ARB_SUMMARY_EVERY', 25),
};

const MAX_FAILED_IN_A_ROW = 3;

function killSwitch(): string | null {
  if (process.env.ARB_KILL === '1') return 'ARB_KILL=1';
  if (fs.existsSync(path.join(config.dataDir, 'STOP'))) return `${path.join(config.dataDir, 'STOP')} exists`;
  return null;
}

function printBook(book: Book, p: Prices, ledger: Ledger): void {
  const cols = [...SYMS, 'dotUSD', 'HDX'] as const;
  const dec: Record<(typeof cols)[number], number> = { DOT: 10, USDT: 6, USDC: 6, dotUSD: 6, HDX: 12 };
  const cell = (v: string) => v.padStart(10);
  log.raw(c.dim(`             ${cols.map((k) => cell(k)).join('')}${cell('USD')}`));
  for (const ch of ['AH', 'HY'] as Chain[]) {
    const vals = cols.map((k) => cell(book[ch][k] === 0n ? '·' : human(book[ch][k], dec[k]).toFixed(k === 'DOT' ? 4 : 2)));
    log.raw(`  ${CHAIN_NAME[ch].padEnd(11)}${vals.join('')}${cell('$' + usdOf(book, p, ch).toFixed(2))}`);
  }
  const equity = usdOf(book, p);
  const s = ledger.summary(equity);
  const a = ledger.state.arbs;
  log.raw(
    `  ${c.bold('Equity')} $${equity.toFixed(2)} ${c.dim(`(DOT $${p.DOT.toFixed(4)})`)}  ` +
      `${c.bold('P&L')} ${usdColored(s.total)} = arb ${usdColored(s.arb)} · setup ${usdColored(s.setup)} · rebalance ${usdColored(s.rebalance)} · market ${usdColored(s.market)}`
  );
  log.raw(
    `  ${c.dim(`baseline $${ledger.state.baseline.usd.toFixed(2)} since ${ledger.state.baseline.at.slice(0, 16)} · ` +
      `arbs ${a.done} (${a.profitable} profitable, ${a.failed} failed) · today ${usd(ledger.dayPnl())} of −$${config.maxDailyLossUsd} limit`)}`
  );
}

async function main(): Promise<void> {
  if (!config.mnemonic) {
    log.error('set ARB_MNEMONIC to the account mnemonic (in the environment or in ../.env)');
    process.exit(1);
  }
  const w = walletFromMnemonic(config.mnemonic, config.derivation);
  log.raw(c.bold('\nHydroid arb · Asset Hub ⇄ Hydration · LIVE'));
  log.raw(`  account     ${w.ah} ${c.dim(`(Hydration ${w.hy})`)}`);
  log.raw(
    c.dim(
      `  trade $${config.minTradeUsd}–$${config.maxTradeUsd} · min profit $${config.minProfitUsd} · ` +
        `daily loss limit $${config.maxDailyLossUsd} · tick ${config.pollSeconds}s · data ${config.dataDir}\n`
    )
  );

  const stop = killSwitch();
  if (stop) {
    log.warn(`kill switch is on (${stop}) — not starting`);
    return;
  }

  log.step(`connecting to ${config.ahRpc} and ${config.hyRpc} …`);
  const chains = await connect(config.ahRpc, config.hyRpc);
  log.ok('connected');

  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    log.warn('stopping after the current step (Ctrl+C again to force)');
  });

  try {
    let [book, p] = await Promise.all([readBook(chains, w), readPrices(chains)]);
    // Checked before the ledger exists: its first equity reading becomes the P&L baseline.
    if (usdOf(book, p) < 2 * config.minTradeUsd) {
      throw new Halt(`account holds $${usdOf(book, p).toFixed(2)} — fund ${w.ah} on Asset Hub first (e.g. 40 USDT)`);
    }
    const { ledger, fresh } = Ledger.open(config.dataDir, w.ah, usdOf(book, p), p);
    if (fresh) log.ok(`new ledger: baseline equity $${ledger.state.baseline.usd.toFixed(2)}`);
    const ctx: Ctx = { c: chains, w, ledger, minProfitUsd: config.minProfitUsd };
    const limits: Limits = { minTradeUsd: config.minTradeUsd, maxTradeUsd: config.maxTradeUsd };
    const quoter: Quoter = {
      ahIn: (pathSyms, amount) => ahQuoteIn(chains, pathSyms, amount),
      ahOut: (pathSyms, amount) => ahQuoteOut(chains, pathSyms, amount),
      hySell: async (from, to, amount) => (await hySell(chains, from, to, amount))?.amountOut ?? null,
      hyBuy: async (from, to, amount) => (await hyBuy(chains, from, to, amount))?.amountIn ?? null,
    };
    printBook(book, p, ledger);

    if (!ledger.state.bootstrapped) await bootstrap(ctx);
    else await ensureHydrationFeeCurrency(ctx);

    let tick = 0;
    let failedInARow = 0;
    while (!stopping) {
      tick += 1;
      const kill = killSwitch();
      if (kill) throw new Halt(`kill switch (${kill})`);
      if (ledger.dayPnl() <= -config.maxDailyLossUsd) throw new Halt(`daily loss limit hit (${usd(ledger.dayPnl())})`);

      try {
        [book, p] = await Promise.all([readBook(chains, w), readPrices(chains)]);
        let acted = false;

        const moves = planRebalance(book, p, limits);
        if (moves.length) {
          await rebalance(ctx, moves);
          acted = true;
          [book, p] = await Promise.all([readBook(chains, w), readPrices(chains)]);
        }

        const psm = await psmState(chains).catch(() => null);
        const [opps, dot] = await Promise.all([findOpportunities(quoter, book, p, limits, psm), dotPrices(ctx, p)]);
        const spread = dot.hy ? ((dot.hy - dot.ah) / dot.ah) * 100 : null;
        const head =
          `#${tick} DOT ${c.cyan('$' + dot.ah.toFixed(4))} AH / ${c.cyan(dot.hy ? '$' + dot.hy.toFixed(4) : '?')} HY` +
          (spread !== null ? c.dim(` (${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%)`) : '');
        const best = opps[0];
        if (!best) log.info(`${head} · ${c.dim('no edge after pool fees')}`);
        else {
          log.info(`${head} · best: ${describe(best, p)} · gross ${usdColored(best.grossUsd)}`);
          const outcome = await executeArb(ctx, best, p, psm);
          if (outcome !== 'skipped') acted = true;
          if (outcome === 'failed') failedInARow += 1;
          if (outcome === 'ok') failedInARow = 0;
          if (failedInARow >= MAX_FAILED_IN_A_ROW) throw new Halt(`${failedInARow} failed arbs in a row`);
        }

        if (acted || tick % config.summaryEvery === 0) {
          const [b2, p2] = await Promise.all([readBook(chains, w), readPrices(chains)]);
          printBook(b2, p2, ledger);
        }
      } catch (e) {
        if (e instanceof Halt) throw e;
        log.error(`tick ${tick}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!stopping) await sleep(config.pollSeconds * 1000);
    }
    log.warn('stopped');
    const [b, pr] = await Promise.all([readBook(chains, w), readPrices(chains)]);
    printBook(b, pr, ledger);
  } catch (e) {
    if (e instanceof Halt) {
      log.error(`HALTED: ${e.message}`);
      process.exitCode = 2;
    } else throw e;
  } finally {
    chains.destroy();
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});

