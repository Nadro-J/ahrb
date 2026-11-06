/**
 * Asset Hub ⇄ Hydration arbitrage bot. Runs live with real funds — there is
 * no paper mode.
 *
 *   ARB_MNEMONIC="word1 … word12" npm start
 *
 * Every tick: read balances and prices on both chains, quote every candidate
 * (cross-chain DOT/USDT/USDC spreads and the Asset Hub PSM peg), and execute
 * the best one only if it is still profitable after every fee. XCM moves
 * inventory between the chains only when a side runs too low to trade.
 *
 * Stops on: Ctrl+C (finishes the current action first), the kill switch
 * (ARB_KILL=1 or a file named STOP in the data dir), the daily loss limit,
 * or an XCM that never arrives. A failed trade doesn't stop it: the error is
 * counted in the ledger (`npm run errors`) and the route pauses for a while.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_NAME, human, SYMS, type Chain } from './assets.js';
import { connect, readBook, readPrices, usdOf, walletFromMnemonic, type Book, type Prices } from './chains.js';
import { bootstrap, dotPrices, missingAssets, typicalXchainFees, ensureHydrationFeeCurrency, executeArb, Halt, rebalance, type Ctx } from './executor.js';
import { recordSample, renderLive, settings, hhmm, ui } from './dashboard.js';
import { c, liveEnabled, log, startLive, stopLive, usd, usdColored } from './log.js';
import { errorKey, failStage, Ledger } from './pnl.js';
import { Cooldowns, describe, findOpportunities, label, planRebalance, type Limits, type Opportunity, type Quoter } from './strategy.js';
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
  chartMinutes: num('ARB_CHART_MINUTES', 5),
  chartHeight: num('ARB_CHART_HEIGHT', 8),
  boardRows: num('ARB_BOARD_ROWS', 5),
};

Object.assign(settings, {
  chartMinutes: config.chartMinutes,
  chartHeight: config.chartHeight,
  boardRows: config.boardRows,
  minProfitUsd: config.minProfitUsd,
  maxDailyLossUsd: config.maxDailyLossUsd,
});

function killSwitch(): string | null {
  if (process.env.ARB_KILL === '1') return 'ARB_KILL=1';
  if (fs.existsSync(path.join(config.dataDir, 'STOP'))) return `${path.join(config.dataDir, 'STOP')} exists`;
  return null;
}


function printBook(book: Book, p: Prices, ledger: Ledger): void {
  const cols = [...SYMS, 'dotUSD', 'HDX'] as const;
  const dec: Record<(typeof cols)[number], number> = { DOT: 10, USDT: 6, USDC: 6, ETH: 18, dotUSD: 6, HDX: 12 };
  const dp = (k: (typeof cols)[number]) => (k === 'ETH' ? 6 : k === 'DOT' ? 4 : 2);
  const cell = (v: string) => v.padStart(10);
  log.raw(c.dim(`             ${cols.map((k) => cell(k)).join('')}${cell('USD')}`));
  for (const ch of ['AH', 'HY'] as Chain[]) {
    const vals = cols.map((k) => cell(book[ch][k] === 0n ? '·' : human(book[ch][k], dec[k]).toFixed(dp(k))));
    log.raw(`  ${CHAIN_NAME[ch].padEnd(11)}${vals.join('')}${cell('$' + usdOf(book, p, ch).toFixed(2))}`);
  }
  const equity = usdOf(book, p);
  const s = ledger.summary(equity);
  const a = ledger.state.arbs;
  syncUi(book, p, ledger);
  log.raw(
    `  ${c.bold('Equity')} $${equity.toFixed(2)} ${c.dim(`(DOT $${p.DOT.toFixed(4)})`)}  ` +
      `${c.bold('P&L')} ${usdColored(s.total)} = arb ${usdColored(s.arb)} · setup ${usdColored(s.setup)} · rebalance ${usdColored(s.rebalance)} · market ${usdColored(s.market)}`
  );
  log.raw(
    `  ${c.dim(`baseline $${ledger.state.baseline.usd.toFixed(2)} since ${ledger.state.baseline.at.slice(0, 16)} · ` +
      `arbs ${a.done} (${a.profitable} profitable, ${a.failed} failed) · today ${usd(ledger.dayPnl())} of −$${config.maxDailyLossUsd} limit`)}`
  );
}

function syncUi(book: Book, p: Prices, ledger: Ledger): void {
  ui.equity = usdOf(book, p);
  ui.pnl = ledger.summary(ui.equity).total;
  ui.day = ledger.dayPnl();
  ui.arbs = { done: ledger.state.arbs.done, failed: ledger.state.arbs.failed };
  ui.errors = ledger.topErrors(2).map(([id, e]) => ({ what: id.split(' ').slice(2).join(' '), stage: e.stage, count: e.count, costUsd: e.costUsd }));
}

async function main(): Promise<void> {
  if (!config.mnemonic) {
    log.error('set ARB_MNEMONIC to the account mnemonic (in the environment or in .env)');
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

  if (process.env.SSH_CONNECTION && !process.env.TMUX && !process.env.STY) {
    log.warn('running over SSH outside tmux/screen: closing the SSH session stops the bot. See README "Running on a server".');
  }

  const stop = killSwitch();
  if (stop) {
    log.warn(`kill switch is on (${stop}) — not starting`);
    return;
  }

  log.step(`connecting to ${config.ahRpc} and ${config.hyRpc} …`);
  const chains = await connect(config.ahRpc, config.hyRpc);
  log.ok('connected');

  let stopping = false;
  let wake: (() => void) | null = null;
  const requestStop = (signal: NodeJS.Signals) => {
    if (stopping && signal === 'SIGINT') process.exit(130);
    stopping = true;
    ui.phase = 'stopping';
    log.warn(`${signal}: stopping after the current step${signal === 'SIGINT' ? ' (Ctrl+C again to force)' : ''}`);
    wake?.();
  };
  process.on('SIGINT', requestStop);
  process.on('SIGTERM', requestStop); // systemd stop
  process.on('SIGHUP', requestStop); // terminal closed
  // With the terminal gone, writes fail with EIO; finishing the current step matters more than the output.
  process.stdout.on('error', () => {});

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
    else {
      // An asset added since the first setup (e.g. ETH) gets set up on its own; failing that, trading goes on without it.
      const missing = missingAssets(book, p);
      if (missing.length) {
        log.step(`no inventory yet for ${missing.join(', ')}: setting it up`);
        await bootstrap(ctx, missing).catch((e) => log.error(`setup of ${missing.join(', ')} failed: ${e instanceof Error ? e.message : String(e)} — trading without it`));
      } else await ensureHydrationFeeCurrency(ctx);
    }

    let tick = 0;
    const cooldowns = new Cooldowns();
    let lastSkipped: string | null = null;
    syncUi(book, p, ledger);
    startLive(renderLive);
    while (!stopping) {
      tick += 1;
      ui.tick = tick;
      const kill = killSwitch();
      if (kill) throw new Halt(`kill switch (${kill})`);
      if (ledger.dayPnl() <= -config.maxDailyLossUsd) throw new Halt(`daily loss limit hit (${usd(ledger.dayPnl())})`);

      try {
        [book, p] = await Promise.all([readBook(chains, w), readPrices(chains)]);
        let acted = false;

        syncUi(book, p, ledger);
        const moves = planRebalance(book, p, limits);
        if (moves.length) {
          ui.phase = 'rebalancing';
          await rebalance(ctx, moves);
          acted = true;
          [book, p] = await Promise.all([readBook(chains, w), readPrices(chains)]);
        }

        ui.phase = 'quoting';
        let closest: Opportunity | null = null;
        const cands: Record<string, number> = {};
        const observe = (o: Opportunity) => {
          if (!closest || o.grossUsd > closest.grossUsd) closest = o;
          const k = label(o);
          cands[k] = Math.max(cands[k] ?? -Infinity, o.grossUsd);
        };
        if (Date.now() - ui.feesAt > 10 * 60_000) {
          ui.feesAt = Date.now();
          ui.fees = (await typicalXchainFees(ctx, p).catch(() => null)) ?? ui.fees;
        }
        const psm = await psmState(chains).catch(() => null);
        const [opps, dot] = await Promise.all([findOpportunities(quoter, book, p, limits, psm, observe), dotPrices(ctx, p)]);
        ui.dot = dot;
        const near = closest as Opportunity | null;
        ui.closest = near ? { what: label(near), gross: near.grossUsd } : null;
        ui.paused = cooldowns.paused();
        recordSample(dot.ah, dot.hy, near?.grossUsd ?? null, cands);
        if (near && (!ui.record || near.grossUsd > ui.record.gross)) ui.record = { what: label(near), gross: near.grossUsd, at: hhmm() };

        const spread = dot.hy ? ((dot.hy - dot.ah) / dot.ah) * 100 : null;
        const head =
          `#${tick} DOT ${c.cyan('$' + dot.ah.toFixed(4))} AH / ${c.cyan(dot.hy ? '$' + dot.hy.toFixed(4) : '?')} HY` +
          (spread !== null ? c.dim(` (${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%)`) : '');
        // The best route that isn't paused after a recent failure.
        const best = opps.find((o) => !cooldowns.pausedFor(label(o)));
        if (!best) {
          ui.skip = null;
          lastSkipped = null;
          // On a terminal the live status shows this; a log file gets a line per tick.
          if (!liveEnabled) log.info(`${head} · ${c.dim('no edge after pool fees')}`);
        } else {
          ui.phase = 'trading';
          const res = await executeArb(ctx, best, p, psm);
          if (res.outcome === 'skipped') {
            // A spread that is too thin to trade can last for hours; print it once, keep it in the status.
            const key = `${label(best)}|${res.reason.replace(/[-+$\d.]+/g, '')}`;
            if (!liveEnabled || key !== lastSkipped) {
              log.info(`${head} · best: ${describe(best, p)} · gross ${usdColored(best.grossUsd)}`);
              log.info(c.dim(`  skip: ${res.reason}`));
            }
            lastSkipped = key;
            ui.skip = `${label(best)}: ${res.reason}`;
          } else {
            lastSkipped = null;
            ui.skip = null;
            acted = true;
            ui.lastTrade = `${hhmm()} ${res.outcome === 'ok' ? 'ok' : 'failed'}`;
          }
          if (res.outcome === 'ok') cooldowns.ok(label(best));
          if (res.outcome === 'failed') {
            // Keep running; note it and rest the route so a broken one can't burn fees every tick.
            const { ms, strikes } = cooldowns.fail(label(best));
            const stage = failStage(res.error);
            log.warn(
              `${label(best)}: ${errorKey(res.error)} (${stage === 'dry-run' ? 'dry run, nothing sent' : stage === 'on-chain' ? 'on chain, fee paid' : stage})` +
                ` · cost ${usd(res.realizedUsd)} · route paused ${Math.round(ms / 60_000)} min (failure ${strikes} in a row) · see npm run errors`
            );
            ui.paused = cooldowns.paused();
          }
        }

        if (acted || (!liveEnabled && tick % config.summaryEvery === 0)) {
          const [b2, p2] = await Promise.all([readBook(chains, w), readPrices(chains)]);
          printBook(b2, p2, ledger);
        }
      } catch (e) {
        if (e instanceof Halt) throw e;
        log.error(`tick ${tick}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!stopping) {
        ui.phase = 'waiting';
        ui.nextAt = Date.now() + config.pollSeconds * 1000;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, config.pollSeconds * 1000);
          wake = () => {
            clearTimeout(t);
            resolve();
          };
        });
        wake = null;
      }
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
    stopLive();
    chains.destroy();
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});

