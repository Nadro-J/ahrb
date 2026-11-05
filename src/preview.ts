/**
 * Draws the live status once from synthetic data, without touching the
 * network: `npm run preview`. For checking the layout at different terminal
 * sizes (`COLUMNS=60 LINES=30 npm run preview`) or with ARB_ASCII=1.
 */
import { noteEthWatch, recordSample, renderLive, settings, ui } from './dashboard.js';
import { log } from './log.js';

const minutes = Number(process.env.ARB_CHART_MINUTES || 15);
const tick = 6;
Object.assign(settings, { chartMinutes: minutes, chartHeight: Number(process.env.ARB_CHART_HEIGHT || 8) });
if (process.env.COLUMNS) process.stdout.columns = Number(process.env.COLUMNS);
if (process.env.LINES) process.stdout.rows = Number(process.env.LINES);

const routes = ['DOT/USDT sell AH→buy HY', 'USDT/USDC sell AH→buy HY', 'psm-redeem', 'DOT/USDC sell HY→buy AH', 'psm-mint'];
const n = (minutes * 60) / tick;
const start = Date.now() - n * tick * 1000;
ui.fees = 0.0038;
for (let i = 0; i < n; i++) {
  const ah = 0.952 + 0.0012 * Math.sin(i / 21);
  const hy = ah - 0.0007 + 0.0009 * Math.sin(i / 12);
  const cands: Record<string, number> = {};
  routes.forEach((r, k) => (cands[r] = -0.004 - 0.002 * k + 0.003 * Math.sin(i / (9 + 4 * k))));
  const eth = -0.006 + 0.012 * Math.max(0, Math.sin(i / 17)) ** 6;
  cands['ETH/DOT sell HY→buy AH (watch)'] = eth;
  cands['ETH/DOT sell AH→buy HY (watch)'] = -0.009;
  const near = Math.max(...routes.map((r) => cands[r]!));
  recordSample(ah, hy, near, cands, start + i * tick * 1000);
  noteEthWatch({ label: 'ETH/DOT sell HY→buy AH', grossUsd: eth, sizeUsd: 2 });
}
Object.assign(ui, {
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
});
for (const line of renderLive()) log.raw(line);
