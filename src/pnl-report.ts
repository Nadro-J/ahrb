/**
 * P&L by time, from the data files alone (no network): `npm run pnl`.
 *
 *   rolling windows   last 1h / 12h / 24h / 7d, ending at the last equity snapshot
 *   sessions          each run of the bot: how long, what trading made, what the market did
 *   days              each UTC day
 *
 * "trading" is what the bot's own actions made, measured (arbs, setup,
 * rebalances). "market" is the rest of the equity change: holding DOT and
 * ETH while their prices move. Deposits recorded with `npm run deposit` are
 * left out of both.
 *
 *   npm run pnl            # windows, the last 10 sessions, the last 14 days
 *   npm run pnl -- 30      # the last 30 sessions and days
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, log, usd, usdColored } from './log.js';
import { duration, equityAt, period, sessionPeriod, windowPeriod, type EntryLite, type Period, type Snapshot } from './periods.js';
import type { State } from './pnl.js';

const dir = process.env.ARB_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const n = Number(process.argv[2] ?? 10);

const lines = <T>(file: string): T[] =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as T];
          } catch {
            return [];
          }
        })
    : [];

const stateFile = path.join(dir, 'state.json');
if (!fs.existsSync(stateFile)) {
  log.info(`no ${stateFile} yet: the bot hasn't run`);
  process.exit(0);
}
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
const entries = lines<EntryLite>(path.join(dir, 'ledger.jsonl'));
const snaps = lines<Snapshot>(path.join(dir, 'equity.jsonl'));
const sessions = state.sessions ?? [];
const deposits = state.deposits ?? [];
const last = snaps.at(-1);

const W = 11;
const cell = (v: number | null, w = W) => (v === null ? c.dim('?'.padStart(w)) : usdColored(v).padStart(w + (usdColored(v).length - usd(v).length)));
const row = (name: string, p: Period) =>
  `  ${name.padEnd(22)}${cell(p.trading)}${cell(p.arb)}${cell(p.rebalance + p.setup)}${cell(p.market)}${cell(p.total)}` +
  c.dim(`   ${p.arbs} arbs, ${p.profitable} profitable, ${p.failed} failed`);
const header = (first: string) =>
  c.dim(`  ${first.padEnd(22)}${['trading', 'arb', 'rebalance', 'market', 'total'].map((h) => h.padStart(W)).join('')}`);

log.raw(c.bold(`\nP&L`) + c.dim(`  (trading = what the bot's actions made; market = holding the coins; total = both)`));
if (!last) log.raw(c.dim('  no equity snapshots yet (data/equity.jsonl): the bot writes one every 10 minutes while it runs'));
else {
  const now = Date.parse(last.ts);
  log.raw(c.bold(`\nRolling windows`) + c.dim(` to ${last.ts.slice(0, 16).replace('T', ' ')} (last snapshot, equity $${last.usd.toFixed(2)})`));
  log.raw(header('window'));
  for (const h of [1, 12, 24, 24 * 7]) {
    const p = windowPeriod(entries, snaps, deposits, h, now, last.usd);
    const name = h < 48 ? `last ${h}h` : `last ${h / 24}d`;
    log.raw(row(name + (p.total === null ? ' (partial)' : ''), p));
  }
}

if (sessions.length) {
  log.raw(c.bold(`\nSessions`) + c.dim(` (each run of the bot; last ${Math.min(n, sessions.length)} of ${sessions.length})`));
  log.raw(header('started · ran for'));
  for (const s of sessions.slice(-n)) {
    const ran = duration(Date.parse(s.end) - Date.parse(s.start));
    log.raw(row(`${s.start.slice(5, 16).replace('T', ' ')} · ${ran}`, sessionPeriod(entries, s)));
  }
}

// Days: from the first entry or snapshot to today, UTC.
const firstTs = [entries[0]?.ts, snaps[0]?.ts].filter((x): x is string => !!x).sort()[0];
if (firstTs && last) {
  log.raw(c.bold(`\nDays`) + c.dim(' (UTC)'));
  log.raw(header('day'));
  const day0 = Date.parse(firstTs.slice(0, 10));
  const days: string[] = [];
  for (let d = day0; d <= Date.parse(last.ts); d += 86_400_000) days.push(new Date(d).toISOString().slice(0, 10));
  for (const d of days.slice(-n)) {
    const from = Date.parse(d);
    const to = Math.min(from + 86_400_000 - 1, Date.parse(last.ts));
    const p = period(entries, from, to, equityAt(snaps, from), equityAt(snaps, to) ?? last.usd, deposits);
    log.raw(row(d + (p.total === null ? ' (partial)' : ''), p));
  }
}

const all = entries.reduce((s, e) => s + e.realizedUsd, 0);
log.raw(c.dim(`\n  all time: trading ${usd(all)} since ${state.baseline.at.slice(0, 16).replace('T', ' ')} · baseline $${state.baseline.usd.toFixed(2)}${deposits.length ? ` (incl. ${deposits.length} deposit${deposits.length > 1 ? 's' : ''})` : ''}\n`));
