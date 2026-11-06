/**
 * The live status region: what the bot is doing, the routes board and the
 * charts. `main.ts` updates `ui` and calls `recordSample()` once per tick;
 * `log.ts` redraws `renderLive()` every second. Kept apart from the loop so
 * the layout can be previewed with fake data.
 */
import { barPlot, extent, linePlot, sparklineIn } from './chart.js';
import { ascii, c, toAscii, usd, usdColored } from './log.js';

/** The settings the dashboard reads; `main.ts` fills them from the config. */
export const settings = {
  chartMinutes: 5,
  chartHeight: 8,
  boardRows: 5,
  minProfitUsd: 0.01,
  maxDailyLossUsd: 2,
};

type Phase = 'starting' | 'rebalancing' | 'quoting' | 'trading' | 'waiting' | 'stopping';

/** What the live status region shows; updated by the loop, drawn every second by log.ts. */
export const ui = {
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
  /** Network fees of a typical cross-chain round trip, refreshed every 10 min. */
  fees: null as number | null,
  feesAt: 0,
  /** Routes paused after a failure, with ms left. */
  paused: {} as Record<string, number>,
  /** The most frequent failures since the ledger began (from the ledger). */
  errors: [] as { what: string; stage: string; count: number; costUsd: number }[],
};

/** Gross needed before a cross-chain trade goes ahead (fees + ARB_MIN_PROFIT_USD), once fees are known. */
export const needed = () => (ui.fees === null ? null : ui.fees + settings.minProfitUsd);

/** One sample per tick for the live charts, trimmed to the last `ARB_CHART_MINUTES`. */
const history: { t: number; ah: number; hy: number | null; near: number | null; cands: Record<string, number> }[] = [];

export function recordSample(ah: number, hy: number | null, near: number | null, cands: Record<string, number>, now = Date.now()): void {
  history.push({ t: now, ah, hy, near, cands });
  while (history.length && history[0]!.t < now - settings.chartMinutes * 60_000) history.shift();
}

const charset = ascii ? 'ascii' : 'unicode';

/** Rows left for the board and charts: the screen minus the status lines and a few rows of log. */
const freeRows = (statusRows: number) => (process.stdout.rows || 24) - 1 - statusRows - 6;

/**
 * Every candidate route with its gross now, a sparkline of the window, and
 * its best in the window; the closest first. A route paused after a failure
 * says so (it isn't traded until the pause ends).
 */
function renderBoard(statusRows: number): string[] {
  const latest = history.at(-1);
  const rows = Math.min(Math.floor(settings.boardRows), freeRows(statusRows) - 6);
  if (!latest || rows < 1) return [];
  const cols = (process.stdout.columns || 80) - 1;
  const need = needed();
  const names = Object.keys(latest.cands)
    .sort((a, b) => latest.cands[b]! - latest.cands[a]!)
    .slice(0, rows);
  // Pad what will actually be printed: in ASCII mode "→" becomes "->".
  const shown = (n: string) => (ascii ? toAscii(n) : n);
  const labelW = Math.max(...names.map((n) => shown(n).length), 10);
  const sw = Math.max(8, Math.min(60, cols - 2 - 9 - 2 - labelW - 2 - 15));
  const out = [`  ${c.bold('routes')} ${c.dim(`gross now · last ${span().slice(1)} · best`)}`];
  for (const name of names) {
    const now = latest.cands[name]!;
    const series = history.map((h) => h.cands[name] ?? null);
    const best = Math.max(...series.filter((v): v is number => v !== null));
    const paint = (bar: string, v: number) => (need !== null && v >= need ? c.yellow(bar) : v > 0 ? c.green(bar) : c.dim(bar));
    const spark = sparklineIn(charset, series, sw, extent(series, 0) ?? undefined, paint);
    out.push(`  ${' '.repeat(Math.max(0, 8 - usd(now).length))}${usdColored(now)}  ${shown(name).padEnd(labelW)}  ${spark}  ${c.dim('best ' + usd(best))}${pausedNote(name)}`);
  }
  return out;
}

function pausedNote(route: string): string {
  const ms = ui.paused[route];
  return ms ? '  ' + c.yellow(`paused ${Math.max(1, Math.ceil(ms / 60_000))}m`) : '';
}

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
  if (!settings.chartMinutes || history.length < 2) return [];
  const cols = (process.stdout.columns || 80) - 1;
  const free = freeRows(statusRows);
  const need = needed();
  const threshold = need === null ? undefined : { value: need, paint: c.yellow };
  const needText = need === null ? 'trades only above $0 + fees' : `trades above ${c.yellow(usd(need, 3))} ${c.dim('(fees + min profit)')}`;
  const ah = history.map((h) => h.ah);
  const hy = history.map((h) => h.hy);
  const near = history.map((h) => h.near);
  const nearPaint = (bar: string, v: number) => (v > 0 ? c.green(bar) : c.dim(bar));

  // Big: title + plot + 2 axis rows, twice.
  const labelWidth = 10;
  const width = Math.max(10, Math.min(history.length, cols - labelWidth - 2));
  // Shrink the plots until both fit: each has a title row, its own rows and two axis rows.
  const nearRows = (h: number) => Math.max(3, Math.round(h * 0.6));
  let priceH = Math.floor(settings.chartHeight);
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
      `  ${c.bold('nearest trade')} ${c.dim('gross, before network fees ·')} ${c.dim(needText)}`,
      ...barPlot(near, width, nearH, (v) => usd(v, 3), { ...opts, paint: nearPaint, threshold }).map((r, i, all) =>
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
  const row = (name: string, chart: string, legend: string) => `  ${c.dim(name.padEnd(10))}${chart}  ${c.dim(legend)}`;
  const lines = [c.dim(`  ── last ${span().slice(1)} ${'─'.repeat(Math.max(0, sw - 8))}`)];
  if (px) lines.push(row('DOT AH/HY', c.cyan(sparklineIn(charset, ah, sw, px)), `$${px[0].toFixed(4)}–$${px[1].toFixed(4)}`));
  if (sp) lines.push(row('spread', sparklineIn(charset, spread, sw, sp), `${sp[0].toFixed(2)}% … ${sp[1] >= 0 ? '+' : ''}${sp[1].toFixed(2)}%`));
  if (nr) lines.push(row('nearest', sparklineIn(charset, near, sw, nr, nearPaint), `${usd(nr[0], 3)} … ${usd(nr[1], 3)} (green > 0)${need === null ? '' : `, needs ${usd(need, 3)}`}`));
  return lines;
}

const SPIN = ascii ? '|/-\\' : '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
export const hhmm = () => new Date().toISOString().slice(11, 16);

function ago(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

export function renderLive(): string[] {
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
    c.dim(` (halt at −$${settings.maxDailyLossUsd})`) +
    ` · arbs ${ui.arbs.done}${ui.arbs.failed ? c.red(` (${ui.arbs.failed} failed)`) : ''}` +
    c.dim(` · last trade ${ui.lastTrade ?? 'none yet'}`);

  const lines = [line1, line2, line3];
  if (ui.errors.length) {
    const list = ui.errors.map((e) => `${e.count}× ${e.what} ${c.dim(`(${e.stage}${e.costUsd ? ` ${usd(e.costUsd, 3)}` : ''})`)}`);
    lines.push(`  ${c.red('errors')} ${list.join(' · ')} ${c.dim('· npm run errors')}`);
  }
  if (ui.skip) lines.push(c.dim(`  skipping: ${ui.skip}`));
  const board = renderBoard(lines.length);
  return [...lines, ...board, ...renderCharts(lines.length + board.length)];
}

