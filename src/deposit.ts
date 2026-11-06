/**
 * Record money added to (or taken out of) the account, so it isn't counted as
 * profit: `npm run deposit -- 10` (USD; negative for a withdrawal). Raises the
 * P&L baseline by that much and notes it in state.json. Offline; run it while
 * the bot is stopped, since the bot rewrites state.json as it runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from './log.js';
import type { State } from './pnl.js';

const dir = process.env.ARB_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const file = path.join(dir, 'state.json');
const amount = Number(process.argv[2]);
if (!Number.isFinite(amount) || amount === 0) {
  log.error('usage: npm run deposit -- <usd>   (e.g. 10, or -5 for a withdrawal)');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  log.error(`no ${file}: the bot hasn't run yet, so the first run will count the whole balance anyway`);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
const before = state.baseline.usd;
state.baseline.usd += amount;
(state.deposits ??= []).push({ at: new Date().toISOString(), usd: amount });
fs.writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
fs.renameSync(`${file}.tmp`, file);
log.ok(`baseline $${before.toFixed(2)} → $${state.baseline.usd.toFixed(2)} (${amount > 0 ? 'deposit' : 'withdrawal'} of $${Math.abs(amount)})`);
