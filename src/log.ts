/** Timestamped, coloured console output. Colours switch off when stdout is not a terminal or NO_COLOR is set. */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
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

export const log = {
  info: (msg: string) => console.log(`${ts()} ${msg}`),
  step: (msg: string) => console.log(`${ts()} ${c.cyan('▸')} ${msg}`),
  tx: (chain: string, msg: string) => console.log(`${ts()} ${c.magenta(chain.padEnd(2))} ${msg}`),
  ok: (msg: string) => console.log(`${ts()} ${c.green('✓')} ${msg}`),
  warn: (msg: string) => console.log(`${ts()} ${c.yellow('!')} ${msg}`),
  error: (msg: string) => console.log(`${ts()} ${c.red('✗')} ${msg}`),
  raw: (msg = '') => console.log(msg),
};
