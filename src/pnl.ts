/**
 * P&L bookkeeping.
 *
 * Every action (setup swap, arb, XCM rebalance) is measured, not estimated:
 * balances on both chains are read before and after, and the difference is
 * valued at the prices from BEFORE the action. That number is what the action
 * itself earned or cost, every fee included (pool, PSM, tx, XCM delivery and
 * execution), with market moves excluded.
 *
 * The account's equity is marked at current prices. What equity gained or lost
 * that the measured actions don't explain is market exposure: holding DOT
 * while its price moves.
 *
 *   total P&L = equity now − equity at the first run (the deposit)
 *             = arb profit + setup costs + rebalance costs + market
 *
 * State lives in `<dataDir>/state.json`, one line per action in
 * `<dataDir>/ledger.jsonl`, and an equity snapshot every 10 minutes in
 * `<dataDir>/equity.jsonl` (for P&L over rolling windows; see periods.ts).
 * Each run of the bot is a session in `state.sessions`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Book, Prices } from './chains.js';
import { sessionPeriod, windowPeriod, type Deposit, type EntryLite, type Period, type Session, type Snapshot } from './periods.js';

export type ActionKind = 'setup' | 'arb' | 'rebalance';

export interface LedgerEntry {
  ts: string;
  kind: ActionKind;
  what: string;
  /** What the quotes promised (arb only). */
  expectedUsd?: number;
  /** Measured book delta at pre-action prices. */
  realizedUsd: number;
  ok: boolean;
  error?: string;
  txs: { chain: string; label: string; hash: string; block: number }[];
  prices: Prices;
  before: Book;
  after: Book;
}

/**
 * Where an action failed. A dry-run failure sent nothing and cost nothing; an
 * on-chain failure was included in a block and paid its fee.
 */
export type FailStage = 'dry-run' | 'on-chain' | 'other';

export interface ErrorStat {
  count: number;
  stage: FailStage;
  /** USD measured across the failed actions (fees of on-chain failures, partial fills). */
  costUsd: number;
  firstAt: string;
  lastAt: string;
  /** What was being done the last time, and the full message. */
  lastWhat: string;
  lastMessage: string;
}

/** "Pallet.Error" if the message names one, else the message with numbers taken out. */
export function errorKey(message: string): string {
  const named = message.match(/\b([A-Z][A-Za-z]+\.[A-Z][A-Za-z]+)\b/);
  if (named) return named[1]!;
  return message.replace(/0x[0-9a-f]+|[\d.]+/gi, '#').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function failStage(message: string): FailStage {
  if (/dry run/i.test(message)) return 'dry-run';
  if (/failed in block/i.test(message)) return 'on-chain';
  return 'other';
}

export interface State {
  version: 1;
  account: string;
  createdAt: string;
  baseline: { usd: number; at: string; prices: Prices };
  bootstrapped: boolean;
  totals: Record<ActionKind, number>;
  arbs: { done: number; profitable: number; failed: number };
  day: { date: string; pnlUsd: number };
  /** Failures grouped by `${kind} ${stage} ${errorKey}`. */
  errors: Record<string, ErrorStat>;
  /** One per run, newest last. */
  sessions: Session[];
  /** Funds added (or taken out, negative), recorded by `npm run deposit`. */
  deposits: Deposit[];
}

/** How often equity is snapshotted (and state.json rewritten while idle: the Pi's SD card would rather not every tick). */
const SNAPSHOT_MS = 10 * 60_000;
const MAX_SESSIONS = 500;

const today = () => new Date().toISOString().slice(0, 10);

/** One JSON object per line; missing file = none. A torn last line (power cut mid-write) is skipped. */
function readLines<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // ignore
    }
  }
  return out;
}
const bigintJson = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

export class Ledger {
  readonly statePath: string;
  readonly ledgerPath: string;
  readonly equityPath: string;
  state: State;
  /** Every ledger entry, slimmed to what the period math needs. */
  readonly entries: EntryLite[];
  readonly snapshots: Snapshot[];

  private constructor(dir: string, state: State) {
    this.statePath = path.join(dir, 'state.json');
    this.ledgerPath = path.join(dir, 'ledger.jsonl');
    this.equityPath = path.join(dir, 'equity.jsonl');
    this.state = state;
    this.entries = readLines<EntryLite>(this.ledgerPath).map(({ ts, kind, realizedUsd, ok }) => ({ ts, kind, realizedUsd, ok }));
    this.snapshots = readLines<Snapshot>(this.equityPath);
  }

  /** Loads the account's state, or starts one with today's equity as the baseline. */
  static open(dir: string, account: string, equityUsd: number, prices: Prices): { ledger: Ledger; fresh: boolean } {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'state.json');
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
      // Added after the first state files were written.
      state.errors ??= {};
      state.sessions ??= [];
      state.deposits ??= [];
      if (state.account !== account) {
        throw new Error(`${file} belongs to ${state.account}, not ${account}. Use another ARB_DATA_DIR or move the file away.`);
      }
      return { ledger: new Ledger(dir, state), fresh: false };
    }
    const now = new Date().toISOString();
    const state: State = {
      version: 1,
      account,
      createdAt: now,
      baseline: { usd: equityUsd, at: now, prices },
      bootstrapped: false,
      totals: { setup: 0, arb: 0, rebalance: 0 },
      arbs: { done: 0, profitable: 0, failed: 0 },
      day: { date: today(), pnlUsd: 0 },
      errors: {},
      sessions: [],
      deposits: [],
    };
    const ledger = new Ledger(dir, state);
    ledger.save();
    return { ledger, fresh: true };
  }

  save(): void {
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  record(e: LedgerEntry): void {
    fs.appendFileSync(this.ledgerPath, JSON.stringify(e, bigintJson) + '\n');
    this.entries.push({ ts: e.ts, kind: e.kind, realizedUsd: e.realizedUsd, ok: e.ok });
    const s = this.state;
    const cur = s.sessions.at(-1);
    if (cur) cur.end = e.ts;
    this.rollDay();
    s.totals[e.kind] += e.realizedUsd;
    if (e.kind !== 'setup') s.day.pnlUsd += e.realizedUsd;
    if (e.kind === 'arb') {
      if (e.ok) {
        s.arbs.done += 1;
        if (e.realizedUsd > 0) s.arbs.profitable += 1;
      } else s.arbs.failed += 1;
    }
    if (!e.ok && e.error) this.noteError(e);
    this.save();
  }

  private noteError(e: LedgerEntry): void {
    const stage = failStage(e.error!);
    const id = `${e.kind} ${stage} ${errorKey(e.error!)}`;
    const prev = this.state.errors[id];
    this.state.errors[id] = {
      count: (prev?.count ?? 0) + 1,
      stage,
      costUsd: (prev?.costUsd ?? 0) + e.realizedUsd,
      firstAt: prev?.firstAt ?? e.ts,
      lastAt: e.ts,
      lastWhat: e.what,
      lastMessage: e.error!,
    };
  }

  /* ------------------------------------------------------------ sessions */

  /** Start a session at `equityUsd` (the bot just started). The previous one keeps the last end it recorded. */
  startSession(equityUsd: number, now = new Date()): void {
    const at = now.toISOString();
    this.state.sessions.push({ start: at, end: at, equityStart: equityUsd, equityEnd: equityUsd });
    if (this.state.sessions.length > MAX_SESSIONS) this.state.sessions.splice(0, this.state.sessions.length - MAX_SESSIONS);
    this.snapshot(equityUsd, now);
    this.save();
  }

  /**
   * The bot is still running with this equity. Updates the session in memory,
   * and every 10 minutes writes an equity snapshot and state.json. `force`
   * writes now (at stop).
   */
  touch(equityUsd: number, now = new Date(), force = false): void {
    const cur = this.state.sessions.at(-1);
    if (cur) {
      cur.end = now.toISOString();
      cur.equityEnd = equityUsd;
    }
    const last = this.snapshots.at(-1);
    if (force || !last || now.getTime() - Date.parse(last.ts) >= SNAPSHOT_MS) {
      this.snapshot(equityUsd, now);
      this.save();
    }
  }

  private snapshot(usd: number, now: Date): void {
    const s = { ts: now.toISOString(), usd };
    this.snapshots.push(s);
    fs.appendFileSync(this.equityPath, JSON.stringify(s) + '\n');
  }

  /** P&L of the running session, with equity as of now. */
  sessionPnl(equityUsd: number, now = Date.now()): { period: Period; startedAt: string } | null {
    const cur = this.state.sessions.at(-1);
    if (!cur) return null;
    const s = { ...cur, end: new Date(now).toISOString(), equityEnd: equityUsd };
    return { period: sessionPeriod(this.entries, s), startedAt: cur.start };
  }

  /** P&L over the last `hours`. */
  windowPnl(hours: number, equityUsd: number, now = Date.now()): Period {
    return windowPeriod(this.entries, this.snapshots, this.state.deposits, hours, now, equityUsd);
  }

  /** The most frequent failures first. */
  topErrors(n = 3): [string, ErrorStat][] {
    return Object.entries(this.state.errors)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, n);
  }

  /** Today's realized P&L (arbs + rebalances), reset at UTC midnight. */
  dayPnl(): number {
    this.rollDay();
    return this.state.day.pnlUsd;
  }

  private rollDay(): void {
    if (this.state.day.date !== today()) this.state.day = { date: today(), pnlUsd: 0 };
  }

  /** The P&L split for display. */
  summary(equityUsd: number): { total: number; arb: number; setup: number; rebalance: number; market: number } {
    const t = this.state.totals;
    const total = equityUsd - this.state.baseline.usd;
    return { total, arb: t.arb, setup: t.setup, rebalance: t.rebalance, market: total - t.arb - t.setup - t.rebalance };
  }
}
