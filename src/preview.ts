/**
 * Draws the live status once from synthetic data, without touching the
 * network: `npm run preview`. For checking the layout at different terminal
 * sizes (`COLUMNS=60 LINES=30 npm run preview`) or with ARB_ASCII=1.
 */
import { recordSample, renderLive, settings, ui } from './dashboard.js';
import { log } from './log.js';

const minutes = Number(process.env.ARB_CHART_MINUTES || 15);
const tick = 6;
Object.assign(settings, { chartMinutes: minutes, chartHeight: Number(process.env.ARB_CHART_HEIGHT || 8) });
if (process.env.COLUMNS) process.stdout.columns = Number(process.env.COLUMNS);
if (process.env.LINES) process.stdout.rows = Number(process.env.LINES);

const routes = ['psm-mint', 'DOT/USDT sell AH→buy HY', 'USDT/USDC sell AH→buy HY', 'psm-redeem', 'DOT/USDC sell HY→buy AH'];
const n = (minutes * 60) / tick;
const start = Date.now() - n * tick * 1000;
ui.fees = 0.0038;
for (let i = 0; i < n; i++) {
  const ah = 0.952 + 0.0012 * Math.sin(i / 21);
  const hy = ah - 0.0007 + 0.0009 * Math.sin(i / 12);
  const cands: Record<string, number> = {};
  routes.forEach((r, k) => (cands[r] = -0.004 - 0.002 * k + 0.003 * Math.sin(i / (9 + 4 * k))));
  const eth = -0.006 + 0.012 * Math.max(0, Math.sin(i / 17)) ** 6;
  cands['ETH/DOT sell HY→buy AH'] = eth;
  cands['ETH/DOT sell AH→buy HY'] = -0.009;
  // dotUSD drifting around the peg, with a spike above $1 the mint loop could take.
  const mid = 1.0005 + 0.0025 * Math.sin(i / 23) + (i > 110 && i < 118 ? 0.006 : 0);
  const peg = { sell: mid - 0.006, buy: mid + 0.006 };
  cands['psm-mint'] = (peg.sell - 1) * 5;
  cands['psm-redeem'] = (1 - 0.0001 - peg.buy) * 5;
  const near = Math.max(...Object.values(cands));
  recordSample(ah, hy, near, cands, start + i * tick * 1000, peg);
}
const period = (trading: number, market: number, arbs: number, failed: number) => ({
  from: 0, to: 0, arb: trading + 0.004, setup: 0, rebalance: -0.004, trading, market, total: trading + market, arbs, profitable: arbs, failed,
});
Object.assign(ui, {
  session: { since: start - 3 * 3_600_000, period: period(0.0183, -0.21, 2, 1) },
  last24: period(0.0337, -0.52, 3, 4),
  peg: { sell: 0.9951, buy: 1.0071 },
  tick: n,
  phase: 'waiting',
  nextAt: Date.now() + 4000,
  started: start,
  dot: { ah: 0.9531, hy: 0.9524 },
  closest: { what: routes[0], gross: -0.0035 },
  record: { what: routes[0], gross: 0.0021, at: '14:02' },
  equity: 40.12,
  pnl: -0.07,
  arbs: { done: 2, failed: 1 },
  lastTrade: '13:40 ok',
  paused: { 'DOT/USDT sell AH→buy HY': 3 * 60_000 },
  errors: [
    { what: 'AssetConversion.ProvidedMinimumNotSufficientForSwap', stage: 'on-chain', count: 3, costUsd: -0.011 },
    { what: 'Token.FundsUnavailable', stage: 'dry-run', count: 1, costUsd: 0 },
  ],
});
for (const line of renderLive()) log.raw(line);
