import { describe, expect, it } from 'vitest';
import { duration, equityAt, period, sessionPeriod, windowPeriod, type EntryLite } from './periods.js';

const H = 3_600_000;
const T0 = Date.parse('2026-11-06T00:00:00Z');
const at = (h: number) => new Date(T0 + h * H).toISOString();
const e = (h: number, kind: EntryLite['kind'], realizedUsd: number, ok = true): EntryLite => ({ ts: at(h), kind, realizedUsd, ok });

const entries = [e(1, 'arb', 0.02), e(2, 'arb', -0.001, false), e(3, 'rebalance', -0.003), e(30, 'arb', 0.01)];

describe('period', () => {
  it('splits trading from market and counts arbs', () => {
    const p = period(entries, T0, T0 + 24 * H, 40, 39.9);
    expect(p.arb).toBeCloseTo(0.019);
    expect(p.rebalance).toBeCloseTo(-0.003);
    expect(p.trading).toBeCloseTo(0.016);
    expect(p.total).toBeCloseTo(-0.1);
    expect(p.market).toBeCloseTo(-0.116);
    expect([p.arbs, p.profitable, p.failed]).toEqual([1, 1, 1]);
  });

  it('takes deposits made inside the period out of the total', () => {
    const p = period([], T0, T0 + 24 * H, 40, 50.2, [{ at: at(5), usd: 10 }, { at: at(-1), usd: 99 }]);
    expect(p.total).toBeCloseTo(0.2);
  });

  it('leaves total and market unknown without a starting equity', () => {
    const p = period(entries, T0, T0 + 24 * H, null, 39.9);
    expect(p.total).toBeNull();
    expect(p.market).toBeNull();
    expect(p.trading).toBeCloseTo(0.016);
  });
});

describe('windows and sessions', () => {
  const snaps = [0, 6, 12, 18, 24, 30].map((h) => ({ ts: at(h), usd: 40 + h / 100 }));

  it('equityAt takes the last snapshot at or before the time', () => {
    expect(equityAt(snaps, T0 + 7 * H)).toBeCloseTo(40.06);
    expect(equityAt(snaps, T0 - H)).toBeNull();
  });

  it('a rolling window starts from the snapshot before it opens', () => {
    const w = windowPeriod(entries, snaps, [], 24, T0 + 31 * H, 40.3);
    expect(w.arb).toBeCloseTo(0.01); // only the arb at 30h falls in (7h, 31h]
    expect(w.total).toBeCloseTo(40.3 - 40.06);
  });

  it('a session uses its own start and end', () => {
    const s = sessionPeriod(entries, { start: at(0.5), end: at(2.5), equityStart: 40, equityEnd: 40.05 });
    expect(s.arb).toBeCloseTo(0.019);
    expect(s.total).toBeCloseTo(0.05);
  });

  it('formats durations', () => {
    expect([duration(45 * 60_000), duration(3 * H + 12 * 60_000), duration(52 * H)]).toEqual(['45m', '3h12m', '2d4h']);
  });
});
