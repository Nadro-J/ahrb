import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deltaUsd, usdOf, type Book, type Prices } from './chains.js';
import { Ledger, type LedgerEntry } from './pnl.js';

const P: Prices = { DOT: 2, USDT: 1, USDC: 1, dotUSD: 1, HDX: 0.01 };
const zero = () => ({ DOT: 0n, USDT: 0n, USDC: 0n, dotUSD: 0n, HDX: 0n });
const B = (ahUsdt: number, hyDot = 0): Book => ({
  AH: { ...zero(), USDT: BigInt(ahUsdt * 1e6) },
  HY: { ...zero(), DOT: BigInt(hyDot * 1e10) },
});

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'arb-pnl-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const entry = (kind: LedgerEntry['kind'], realizedUsd: number, ok = true): LedgerEntry => ({
  ts: new Date().toISOString(),
  kind,
  what: 'test',
  realizedUsd,
  ok,
  txs: [],
  prices: P,
  before: B(40),
  after: B(40),
});

describe('book valuation', () => {
  it('values every chain and asset', () => {
    expect(usdOf(B(40, 5), P)).toBeCloseTo(50);
    expect(usdOf(B(40, 5), P, 'HY')).toBeCloseTo(10);
  });
  it('deltaUsd prices both books at the same prices', () => {
    // Traded 10 USDT for 4.9 DOT at DOT=$2: cost $0.20 regardless of later DOT moves.
    expect(deltaUsd(B(40), B(30, 4.9), P)).toBeCloseTo(-0.2);
  });
});

describe('Ledger', () => {
  it('takes the first equity as the baseline and keeps it across restarts', () => {
    const dir = tmp();
    const first = Ledger.open(dir, 'acct', 40, P);
    expect(first.fresh).toBe(true);
    first.ledger.record(entry('setup', -0.25));
    const again = Ledger.open(dir, 'acct', 39.5, P);
    expect(again.fresh).toBe(false);
    expect(again.ledger.state.baseline.usd).toBe(40);
    expect(again.ledger.state.totals.setup).toBeCloseTo(-0.25);
  });

  it('refuses a state file that belongs to another account', () => {
    const dir = tmp();
    Ledger.open(dir, 'acct', 40, P);
    expect(() => Ledger.open(dir, 'other', 40, P)).toThrow(/belongs to acct/);
  });

  it('splits P&L into arb, costs and market', () => {
    const { ledger } = Ledger.open(tmp(), 'acct', 40, P);
    ledger.record(entry('setup', -0.2));
    ledger.record(entry('arb', 0.05));
    ledger.record(entry('arb', -0.01, false));
    ledger.record(entry('rebalance', -0.03));
    const s = ledger.summary(40.5);
    expect(s.total).toBeCloseTo(0.5);
    expect(s.arb).toBeCloseTo(0.04);
    expect(s.setup).toBeCloseTo(-0.2);
    expect(s.rebalance).toBeCloseTo(-0.03);
    expect(s.market).toBeCloseTo(0.5 - 0.04 + 0.2 + 0.03);
    expect(ledger.state.arbs).toEqual({ done: 1, profitable: 1, failed: 1 });
  });

  it('counts arbs and rebalances, not setup, against the daily loss limit', () => {
    const { ledger } = Ledger.open(tmp(), 'acct', 40, P);
    ledger.record(entry('setup', -1));
    ledger.record(entry('arb', -0.1));
    ledger.record(entry('rebalance', -0.05));
    expect(ledger.dayPnl()).toBeCloseTo(-0.15);
  });

  it('writes one JSON line per action with bigints as strings', () => {
    const dir = tmp();
    const { ledger } = Ledger.open(dir, 'acct', 40, P);
    ledger.record(entry('arb', 0.01));
    const lines = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).before.AH.USDT).toBe('40000000');
  });
});
