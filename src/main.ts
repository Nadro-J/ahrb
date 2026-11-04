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
 * 3 failed arbs in a row, or an XCM that never arrives.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAIN_NAME, human, SYMS, type Chain } from './assets.js';
import { connect, readBook, readPrices, usdOf, walletFromMnemonic, type Book, type Prices } from './chains.js';
import { bootstrap, dotPrices, ensureHydrationFeeCurrency, executeArb, Halt, rebalance, type Ctx } from './executor.js';
import { barPlot, extent, linePlot, sparklineIn } from './chart.js';
import { ascii, c, liveEnabled, log, startLive, stopLive, usd, usdColored } from './log.js';
import { Ledger } from './pnl.js';
import { describe, findOpportunities, label, planRebalance, type Limits, type Opportunity, type Quoter } from './strategy.js';
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
};

const MAX_FAILED_IN_A_ROW = 3;

function killSwitch(): string | null {
  if (process.env.ARB_KILL === '1') return 'ARB_KILL=1';
  if (fs.existsSync(path.join(config.dataDir, 'STOP'))) return `${path.join(config.dataDir, 'STOP')} exists`;
  return null;
}

/* ---------------------------------------------------------- live status */

type Phase = 'starting' | 'rebalancing' | 'quoting' | 'trading' | 'waiting' | 'stopping';

/** What the live status region shows; updated by the loop, drawn every second by log.ts. */
const ui = {
  started: Date.now(),
  tick: 0,
  phase: 'starting' as Phase,
  nextAt: 0,
  dot: null as { ah: number; hy: number | null } | null,
  /** The best candidate this tick, losing or not (gross, before tx fees). */
  closest: null as { what: string; gross: number } | null,
  /** The best candidate seen since start. */
  record: null as { what: string; gross: number; at: string } | null,
  skip: null as string | null,
  equity: 0,
  pnl: 0,
  day: 0,
  arbs: { done: 0, failed: 0 },
  lastTrade: null as string | null,
};

/** One sample per tick for the live charts, trimmed to the last `ARB_CHART_MINUTES`. */
const history: { t: number; ah: number; hy: number | null; near: number | null }[] = [];

function recordSample(ah: number, hy: number | null, near: number | null): void {
  const now = Date.now();
  history.push({ t: now, ah, hy, near });
  while (history.length && history[0]!.t < now - config.chartMinutes * 60_000) history.shift();
}

const charset = ascii ? 'ascii' : 'unicode';

/** How far back the history goes, as an axis label: "-45s", "-5m". */
function span(): string {
  const secs = Math.round((history.at(-1)!.t - history[0]!.t) / 1000);
  return secs < 90 ? `-${secs}s` : `-${Math.round(secs / 60)}m`;
}

/**
 * Charts of the last few minutes, sized to the terminal:
 *  - big (ARB_CHART_HEIGHT ≥ 3 and room on screen): DOT price on both chains
 *    as a line plot, and the nearest trade as bars around $0;
 *  - compact: one-line sparklines for price, spread and nearest trade;
 *  - none, when even that doesn't fit.
 * `statusRows` is what the status lines above already use; a few rows are left
 * free so the latest log lines stay visible.
 */
function renderCharts(statusRows: number): string[] {
  if (!config.chartMinutes || history.length < 2) return [];
  const cols = (process.stdout.columns || 80) - 1;
  const free = (process.stdout.rows || 24) - 1 - statusRows - 6;
  const ah = history.map((h) => h.ah);
  const hy = history.map((h) => h.hy);
  const near = history.map((h) => h.near);
  const nearPaint = (bar: string, v: number) => (v > 0 ? c.green(bar) : c.dim(bar));

  // Big: title + plot + 2 axis rows, twice.
  const labelWidth = 10;
  const width = Math.max(10, Math.min(history.length, cols - labelWidth - 2));
  // Shrink the plots until both fit: each has a title row, its own rows and two axis rows.
  const nearRows = (h: number) => Math.max(3, Math.round(h * 0.6));
  let priceH = Math.floor(config.chartHeight);
  while (priceH >= 3 && 3 + priceH + 3 + nearRows(priceH) > free) priceH -= 1;
  const nearH = nearRows(priceH);
  if (priceH >= 3) {
    const opts = { charset, labelWidth, leftLabel: span() } as const;
    const ahMark = c.cyan(ascii ? 'o' : '●');
    const hyMark = c.magenta(ascii ? 'x' : '●');
    return [
      `  ${c.bold('DOT price')}   ${ahMark} Asset Hub   ${hyMark} Hydration   ${c.dim(`${ascii ? '@' : '◆'} both`)}`,
      ...linePlot(
        [
          { values: ah, mark: ascii ? 'o' : '●', paint: c.cyan },
          { values: hy, mark: ascii ? 'x' : '●', paint: c.magenta },
        ],
        width,
        priceH,
        (v) => `$${v.toFixed(4)}`,
        opts
      ).map((r, i, all) => (i >= all.length - 2 ? c.dim(r) : r)),
      `  ${c.bold('nearest trade')} ${c.dim('gross, before network fees · trades only above $0 + fees')}`,
      ...barPlot(near, width, nearH, (v) => usd(v, 3), { ...opts, paint: nearPaint }).map((r, i, all) =>
        i >= all.length - 2 ? c.dim(r) : r
      ),
    ];
  }

  // Compact: a heading and three sparklines.
  if (free < 4) return [];
  const sw = Math.max(10, Math.min(120, cols - 11 - 26));
  const spread = history.map((h) => (h.hy ? ((h.hy - h.ah) / h.ah) * 100 : null));
  const px = extent([...ah, ...hy]);
  const sp = extent(spread, 0);
  const nr = extent(near, 0);
  const row = (name: string, chart: string, legend: string) => `  ${c.dim(name.padEnd(9))}${chart}  ${c.dim(legend)}`;
  const lines = [c.dim(`  ── last ${span().slice(1)} ${'─'.repeat(Math.max(0, sw - 8))}`)];
  if (px) lines.push(row('DOT AH/HY', c.cyan(sparklineIn(charset, ah, sw, px)), `$${px[0].toFixed(4)}–$${px[1].toFixed(4)}`));
  if (sp) lines.push(row('spread', sparklineIn(charset, spread, sw, sp), `${sp[0].toFixed(2)}% … ${sp[1] >= 0 ? '+' : ''}${sp[1].toFixed(2)}%`));
  if (nr) lines.push(row('nearest', sparklineIn(charset, near, sw, nr, nearPaint), `${usd(nr[0], 3)} … ${usd(nr[1], 3)} (green > 0)`));
  return lines;
}

const SPIN = ascii ? '|/-\\' : '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const hhmm = () => new Date().toISOString().slice(11, 16);

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

function renderLive(): string[] {
  const busy = ui.phase !== 'waiting';
  const pulse = busy ? c.cyan(SPIN[Math.floor(Date.now() / 250) % SPIN.length]!) : c.green('●');
  const doing = busy ? c.cyan(ui.phase) : c.dim(`next check ${Math.max(0, Math.ceil((ui.nextAt - Date.now()) / 1000))}s`);
  let dot = '';
  if (ui.dot) {
    const { ah, hy } = ui.dot;
    const spread = hy ? ((hy - ah) / ah) * 100 : null;
    dot = ` · DOT ${c.cyan('$' + ah.toFixed(4))} AH / ${c.cyan(hy ? '$' + hy.toFixed(4) : '?')} HY`;
    if (spread !== null) dot += c.dim(` (${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%)`);
  }
  const line1 = `${pulse} ${c.bold('LIVE')} #${ui.tick} ${c.dim('up ' + ago(Date.now() - ui.started))}${dot} · ${doing}`;

  const near = ui.closest ? `${usdColored(ui.closest.gross)} ${c.dim(ui.closest.what)}` : c.dim('—');
  const rec = ui.record ? ` · best since start ${usdColored(ui.record.gross)} ${c.dim('at ' + ui.record.at)}` : '';
  const line2 = `  nearest trade ${near}${rec}`;

  const line3 =
    `  equity $${ui.equity.toFixed(2)} · P&L ${usdColored(ui.pnl, 2)} · today ${usdColored(ui.day, 2)}` +
    c.dim(` (halt at −$${config.maxDailyLossUsd})`) +
    ` · arbs ${ui.arbs.done}${ui.arbs.failed ? c.red(` (${ui.arbs.failed} failed)`) : ''}` +
    c.dim(` · last trade ${ui.lastTrade ?? 'none yet'}`);

  const lines = [line1, line2, line3];
  if (ui.skip) lines.push(c.dim(`  skipping: ${ui.skip}`));
  return [...lines, ...renderCharts(lines.length)];
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
    else await ensureHydrationFeeCurrency(ctx);

    let tick = 0;
    let failedInARow = 0;
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
        const observe = (o: Opportunity) => {
          if (!closest || o.grossUsd > closest.grossUsd) closest = o;
        };
        const psm = await psmState(chains).catch(() => null);
        const [opps, dot] = await Promise.all([findOpportunities(quoter, book, p, limits, psm, observe), dotPrices(ctx, p)]);
        ui.dot = dot;
        const near = closest as Opportunity | null;
        ui.closest = near ? { what: label(near), gross: near.grossUsd } : null;
        recordSample(dot.ah, dot.hy, near?.grossUsd ?? null);
        if (near && (!ui.record || near.grossUsd > ui.record.gross)) ui.record = { what: label(near), gross: near.grossUsd, at: hhmm() };

        const spread = dot.hy ? ((dot.hy - dot.ah) / dot.ah) * 100 : null;
        const head =
          `#${tick} DOT ${c.cyan('$' + dot.ah.toFixed(4))} AH / ${c.cyan(dot.hy ? '$' + dot.hy.toFixed(4) : '?')} HY` +
          (spread !== null ? c.dim(` (${spread >= 0 ? '+' : ''}${spread.toFixed(2)}%)`) : '');
        const best = opps[0];
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
          if (res.outcome === 'failed') failedInARow += 1;
          if (res.outcome === 'ok') failedInARow = 0;
          if (failedInARow >= MAX_FAILED_IN_A_ROW) throw new Halt(`${failedInARow} failed arbs in a row`);
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

