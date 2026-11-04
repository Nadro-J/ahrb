/**
 * Timestamped, coloured console output, plus an optional live status region.
 *
 * Colours switch off when stdout is not a terminal or NO_COLOR is set. The
 * live region (a few lines redrawn in place at the bottom of the terminal)
 * only exists on a TTY and can be switched off with ARB_PLAIN=1. Normal log
 * lines are printed above it, so the scrollback keeps only what happened.
 */
const out = process.stdout;
const useColor = out.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: paint(2),
  bold: paint(1),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
  blue: paint(34),
  magenta: paint(35),
  cyan: paint(36),
};

const ts = () => c.dim(new Date().toISOString().slice(11, 19));

export const usd = (v: number, dp = 4) => `${v < 0 ? '-' : v > 0 ? '+' : ' '}$${Math.abs(v).toFixed(dp)}`;
export const usdColored = (v: number, dp = 4) => (v > 0 ? c.green : v < 0 ? c.red : c.dim)(usd(v, dp));

/* ------------------------------------------------------------ live region */

/** True when the live status region is in use (interactive terminal). */
export const liveEnabled = Boolean(out.isTTY) && process.env.ARB_PLAIN !== '1';

const ANSI = /(\x1b\[[0-9;?]*[A-Za-z])/;

/** Cut `s` to `width` visible characters, keeping colour codes intact. */
export function fit(s: string, width: number): string {
  const parts = s.split(ANSI);
  const visible = parts.reduce((n, p, i) => n + (i % 2 ? 0 : Array.from(p).length), 0);
  if (visible <= width) return s;
  let res = '';
  let left = Math.max(0, width - 1);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2) res += parts[i];
    else {
      const chars = Array.from(parts[i]!);
      res += chars.slice(0, left).join('');
      left -= Math.min(left, chars.length);
      if (left === 0) break;
    }
  }
  return `${res}…${useColor ? '\x1b[0m' : ''}`;
}

let render: (() => string[]) | null = null;
let drawn = 0;
let timer: NodeJS.Timeout | null = null;
let prev: Pick<Console, 'log' | 'error' | 'warn'> | null = null;

function clearLive(): void {
  if (!drawn) return;
  out.write(`\r${drawn > 1 ? `\x1b[${drawn - 1}A` : ''}\x1b[J`);
  drawn = 0;
}

function drawLive(): void {
  if (!render) return;
  const width = Math.max(20, (out.columns || 80) - 1);
  const lines = render().map((l) => fit(l, width));
  out.write(lines.join('\n'));
  drawn = lines.length;
}

/** Print above the live region, then put it back. */
const above =
  (fn: (...a: unknown[]) => void) =>
  (...args: unknown[]) => {
    clearLive();
    fn(...args);
    drawLive();
  };

/**
 * Show `fn()` as the live region, redrawn every second and after every log
 * line. No-op when the live region is off.
 */
export function startLive(fn: () => string[]): void {
  if (!liveEnabled || render) return;
  render = fn;
  // Anything else that prints (the SDK, uncaught errors) must not tear the region.
  // Wrap whatever console.log is now: chains.ts has already filtered it.
  prev = { log: console.log, error: console.error, warn: console.warn };
  console.log = above(prev.log);
  console.error = above(prev.error);
  console.warn = above(prev.warn);
  out.write('\x1b[?25l'); // hide the cursor
  process.on('exit', stopLive);
  timer = setInterval(() => {
    clearLive();
    drawLive();
  }, 1000);
  timer.unref();
  drawLive();
}

/** Remove the live region and restore the terminal. */
export function stopLive(): void {
  if (!render) return;
  if (timer) clearInterval(timer);
  clearLive();
  render = null;
  if (prev) Object.assign(console, prev);
  prev = null;
  out.write('\x1b[?25h');
}

/* --------------------------------------------------------------- logging */

const print = (msg: string) => console.log(msg);

export const log = {
  info: (msg: string) => print(`${ts()} ${msg}`),
  step: (msg: string) => print(`${ts()} ${c.cyan('▸')} ${msg}`),
  tx: (chain: string, msg: string) => print(`${ts()} ${c.magenta(chain.padEnd(2))} ${msg}`),
  ok: (msg: string) => print(`${ts()} ${c.green('✓')} ${msg}`),
  warn: (msg: string) => print(`${ts()} ${c.yellow('!')} ${msg}`),
  error: (msg: string) => print(`${ts()} ${c.red('✗')} ${msg}`),
  raw: (msg = '') => print(msg),
};
