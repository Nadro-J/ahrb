/**
 * P&L over a stretch of time: a session (one run of the bot) or a rolling
 * window (last 1h / 12h / 24h / 7d). Pure, so the specs drive it directly.
 *
 *   trading = what the bot's own actions earned or cost, measured (arb +
 *             setup + rebalance entries in the ledger within the period)
 *   total   = equity at the end − equity at the start − deposits in between
 *   market  = total − trading: holding the coins while prices moved
 *
 * Equity at the start of a rolling window comes from the equity snapshots
 * (`equity.jsonl`, one every 10 min). When the window starts before the first
 * snapshot, total and market are unknown (null) and only trading is given.
 */
import type { ActionKind } from './pnl.js';

export interface EntryLite {
  ts: string;
  kind: ActionKind;
  realizedUsd: number;
  ok: boolean;
}

export interface Snapshot {
  ts: string;
  usd: number;
}

export interface Deposit {
  at: string;
  usd: number;
}

export interface Session {
  start: string;
  /** Last time the session was seen running (updated every snapshot, every action and at stop). */
  end: string;
  equityStart: number;
  equityEnd: number;
}

export interface Period {
  from: number;
  to: number;
  arb: number;
  setup: number;
  rebalance: number;
  /** arb + setup + rebalance */
  trading: number;
  /** null when the equity at `from` isn't known */
  market: number | null;
  total: number | null;
  arbs: number;
  profitable: number;
  failed: number;
}

const t = (iso: string) => Date.parse(iso);

/** The last snapshot at or before `at`, or null if there is none that early. */
export function equityAt(snaps: Snapshot[], at: number): number | null {
  let found: number | null = null;
  for (const s of snaps) {
    if (t(s.ts) > at) break;
    found = s.usd;
  }
  return found;
}

export function period(
  entries: EntryLite[],
  from: number,
  to: number,
  equityFrom: number | null,
  equityTo: number,
  deposits: Deposit[] = []
): Period {
  const p: Period = { from, to, arb: 0, setup: 0, rebalance: 0, trading: 0, market: null, total: null, arbs: 0, profitable: 0, failed: 0 };
  for (const e of entries) {
    const at = t(e.ts);
    if (at < from || at > to) continue;
    p[e.kind] += e.realizedUsd;
    if (e.kind === 'arb') {
      if (!e.ok) p.failed += 1;
      else {
        p.arbs += 1;
        if (e.realizedUsd > 0) p.profitable += 1;
      }
    }
  }
  p.trading = p.arb + p.setup + p.rebalance;
  if (equityFrom !== null) {
    const added = deposits.filter((d) => t(d.at) > from && t(d.at) <= to).reduce((s, d) => s + d.usd, 0);
    p.total = equityTo - equityFrom - added;
    p.market = p.total - p.trading;
  }
  return p;
}

/** A session's P&L; its equity at start is exact (read when it started). */
export function sessionPeriod(entries: EntryLite[], s: Session): Period {
  return period(entries, t(s.start), t(s.end), s.equityStart, s.equityEnd);
}

/** P&L over the last `hours` up to `now`, starting from the equity snapshot at or before the window opens. */
export function windowPeriod(entries: EntryLite[], snaps: Snapshot[], deposits: Deposit[], hours: number, now: number, equityNow: number): Period {
  const from = now - hours * 3_600_000;
  return period(entries, from, now, equityAt(snaps, from), equityNow, deposits);
}

/** "3h12m", "45m", "2d4h". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}
