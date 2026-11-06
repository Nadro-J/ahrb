/**
 * What has gone wrong, from the ledger alone (no network): `npm run errors`.
 *
 * Groups every failed action by kind, stage and error, with its count, its
 * measured cost, when it first and last happened, and the last message in
 * full; then lists the most recent failures. "dry-run" failures sent nothing
 * and cost nothing; "on-chain" ones were included in a block and paid fees.
 *
 *   npm run errors            # summary + last 10 failures
 *   npm run errors -- 30      # summary + last 30
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, log, usd } from './log.js';
import { errorKey, failStage, type LedgerEntry, type State } from './pnl.js';

const dir = process.env.ARB_DATA_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const recent = Number(process.argv[2] ?? 10);
const ledgerFile = path.join(dir, 'ledger.jsonl');
const stateFile = path.join(dir, 'state.json');

if (!fs.existsSync(ledgerFile)) {
  log.info(`no ledger at ${ledgerFile} yet: nothing has been traded`);
  process.exit(0);
}

const failures = fs
  .readFileSync(ledgerFile, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LedgerEntry)
  .filter((e) => !e.ok && e.error);

// Recomputed from the ledger, so it also covers failures from before the state file tracked errors.
const groups = new Map<string, { n: number; cost: number; first: string; last: string; what: string; msg: string }>();
for (const e of failures) {
  const id = `${e.kind} ${failStage(e.error!)} ${errorKey(e.error!)}`;
  const g = groups.get(id) ?? { n: 0, cost: 0, first: e.ts, last: e.ts, what: e.what, msg: e.error! };
  groups.set(id, { n: g.n + 1, cost: g.cost + e.realizedUsd, first: g.first, last: e.ts, what: e.what, msg: e.error! });
}

const state = fs.existsSync(stateFile) ? (JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State) : null;
const arbs = state?.arbs;
log.raw(c.bold(`\nFailures: ${failures.length}`) + (arbs ? c.dim(` (arbs: ${arbs.done} done, ${arbs.failed} failed)`) : ''));
if (!failures.length) process.exit(0);

const t = (iso: string) => iso.slice(0, 16).replace('T', ' ');
for (const [id, g] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  const [kind, stage, ...err] = id.split(' ');
  log.raw(
    `\n  ${c.red(`${g.n}×`)} ${c.bold(err.join(' '))}  ${c.dim(`${kind}, ${stage === 'dry-run' ? 'dry run (nothing sent)' : stage === 'on-chain' ? 'on chain (fees paid)' : stage}`)}`
  );
  log.raw(`     cost ${usd(g.cost)} · first ${t(g.first)} · last ${t(g.last)}`);
  log.raw(c.dim(`     last: ${g.what}`));
  log.raw(c.dim(`     ${g.msg}`));
}

log.raw(c.bold(`\nLast ${Math.min(recent, failures.length)}:`));
for (const e of failures.slice(-recent)) {
  log.raw(`  ${t(e.ts)}  ${usd(e.realizedUsd)}  ${e.what}`);
  log.raw(c.dim(`                    ${e.error}`));
}
log.raw('');
