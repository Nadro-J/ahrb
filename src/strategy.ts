/**
 * Finding the best trade. Pure apart from the injected `Quoter`, so the specs
 * drive it with fake prices.
 *
 * Two families, both delta-neutral in what they trade through:
 *
 *   xchain      sell `size` of BASE for QUOTE on one chain, buy the same
 *               `size` of BASE back with QUOTE on the other — at the same
 *               time, from inventory already on both chains. BASE holdings
 *               end where they started; the profit is the QUOTE left over.
 *               Every ordered pair of DOT/USDT/USDC/ETH in both chain
 *               directions is checked.
 *
 *   psm-mint    (dotUSD rich vs USDT) USDT --PSM mint--> dotUSD --pool--> USDT
 *   psm-redeem  (dotUSD cheap)        USDT --pool--> dotUSD --PSM redeem--> USDT
 *               Asset Hub only, executed as one utility.batch_all, so it is
 *               all-or-nothing.
 *
 * Gross profit here is from quotes (pool fees included). Network fees are
 * added by the executor once it has the real transactions to estimate.
 */
import { ASSETS, CHAINS, SYMS, native, type Chain, type Sym } from './assets.js';
import type { Book, Prices } from './chains.js';
import { ahPath, psmFee, type AhSym, type PsmState } from './venues.js';

export interface Quoter {
  /** Asset Hub exact-in: output for `amountIn` along `path`. */
  ahIn(path: AhSym[], amountIn: bigint): Promise<bigint | null>;
  /** Asset Hub exact-out: input needed for `amountOut`. */
  ahOut(path: AhSym[], amountOut: bigint): Promise<bigint | null>;
  /** Hydration: output for selling `amountIn` of `from`. */
  hySell(from: Sym, to: Sym, amountIn: bigint): Promise<bigint | null>;
  /** Hydration: input of `from` needed to buy `amountOut` of `to`. */
  hyBuy(from: Sym, to: Sym, amountOut: bigint): Promise<bigint | null>;
}

export type Opportunity =
  | {
      kind: 'xchain';
      sellOn: Chain;
      buyOn: Chain;
      base: Sym;
      quote: Sym;
      /** BASE sold on `sellOn` and bought back on `buyOn`. */
      size: bigint;
      /** QUOTE received on `sellOn`. */
      received: bigint;
      /** QUOTE paid on `buyOn`. */
      paid: bigint;
      grossUsd: number;
    }
  | { kind: 'psm-mint'; usdtIn: bigint; minted: bigint; usdtOut: bigint; grossUsd: number }
  | { kind: 'psm-redeem'; dotUsd: bigint; usdtIn: bigint; usdtOut: bigint; grossUsd: number };

export interface Limits {
  minTradeUsd: number;
  maxTradeUsd: number;
  /**
   * Largest PSM trade (default: maxTradeUsd). PSM loops are atomic, need only
   * USDT on Asset Hub and go through the deep dotUSD/DOT pool, so they can
   * size up further than cross-chain trades.
   */
  psmMaxTradeUsd?: number;
}

/**
 * Balance kept back from trading on each chain: fees, existential deposits,
 * XCM delivery. ETH: twice its existential deposit (AH 0.000015, HY 0.0000054).
 */
export const RESERVE: Record<Chain, Record<Sym, bigint>> = {
  AH: { DOT: native(0.15, 10), USDT: native(0.02, 6), USDC: native(0.02, 6), ETH: native(0.00003, 18) },
  HY: { DOT: native(0.05, 10), USDT: native(0.02, 6), USDC: native(0.02, 6), ETH: native(0.000011, 18) },
};

export function tradeable(book: Book, chain: Chain, sym: Sym): bigint {
  const v = book[chain][sym] - RESERVE[chain][sym];
  return v > 0n ? v : 0n;
}

/** Trade sizes to try, in USD: a ladder from the minimum up to the cap. */
export function sizeLadder(l: Limits): number[] {
  const steps = [1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30, 40, 50, 75, 100];
  const ladder = steps.map((s) => s * l.minTradeUsd).filter((s) => s <= l.maxTradeUsd + 1e-9);
  if (!ladder.length) return [l.minTradeUsd];
  // The cap itself is the last step, so e.g. a $25 cap is tried at $25 and not only at $20.
  if (ladder.at(-1)! < l.maxTradeUsd - 1e-9) ladder.push(l.maxTradeUsd);
  return ladder;
}

const units = (sym: Sym, usd: number, p: Prices) => native(usd / p[sym], ASSETS[sym].decimals);
const toUsd = (sym: Sym, amount: bigint, p: Prices) => (Number(amount) / 10 ** ASSETS[sym].decimals) * p[sym];
const other = (ch: Chain): Chain => (ch === 'AH' ? 'HY' : 'AH');

/** Quote one xchain candidate at `size`. */
async function quoteXchain(q: Quoter, sellOn: Chain, base: Sym, quote: Sym, size: bigint, p: Prices): Promise<Opportunity | null> {
  const buyOn = other(sellOn);
  const received = sellOn === 'AH' ? await q.ahIn(ahPath(base, quote), size) : await q.hySell(base, quote, size);
  if (!received) return null;
  const paid = buyOn === 'AH' ? await q.ahOut(ahPath(quote, base), size) : await q.hyBuy(quote, base, size);
  if (!paid) return null;
  return { kind: 'xchain', sellOn, buyOn, base, quote, size, received, paid, grossUsd: toUsd(quote, received - paid, p) };
}

export type Observe = (o: Opportunity) => void;

/**
 * Walk `sizes` up while the candidate stays fundable and keeps improving;
 * return its most profitable size (null when no size pays). Every fundable
 * quote goes to `observe`, losing ones included (the status shows the closest).
 */
async function bestSize(
  sizes: number[],
  quoteAt: (usd: number) => Promise<Opportunity | null>,
  fits: (o: Opportunity) => boolean,
  observe?: Observe
): Promise<Opportunity | null> {
  let top: Opportunity | null = null;
  for (const usd of sizes) {
    const o = await quoteAt(usd).catch(() => null);
    if (!o || !fits(o)) break; // bigger only gets worse once inventory or the pools run out
    observe?.(o);
    if (o.grossUsd <= 0) break; // slippage grows with size: past break-even it never comes back
    if (!top || o.grossUsd > top.grossUsd) top = o;
  }
  return top;
}

/** Run `jobs` with at most `n` in flight (quotes are RPC round trips; the public endpoints don't like 24 at once). */
async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    })
  );
  return out;
}

/**
 * Every cross-chain candidate (each ordered pair of assets, both chain
 * directions), screened at the smallest size; the ones in profit there are
 * walked up the size ladder. Candidates the inventory can't fund are skipped.
 */
export async function findXchain(q: Quoter, book: Book, p: Prices, l: Limits, observe?: Observe, concurrency = 6): Promise<Opportunity[]> {
  const ladder = sizeLadder(l);
  const jobs: (() => Promise<Opportunity | null>)[] = [];
  for (const sellOn of CHAINS) {
    for (const base of SYMS) {
      for (const quote of SYMS) {
        if (base === quote) continue;
        const buyOn = other(sellOn);
        jobs.push(() =>
          bestSize(
            ladder,
            (usd) => quoteXchain(q, sellOn, base, quote, units(base, usd, p), p),
            (o) => o.kind === 'xchain' && o.size <= tradeable(book, sellOn, base) && o.paid <= tradeable(book, buyOn, quote) && o.size > 0n,
            observe
          )
        );
      }
    }
  }
  const found = (await pool(jobs, concurrency)).filter((o): o is Opportunity => o !== null);
  return found.sort((a, b) => b.grossUsd - a.grossUsd);
}

/**
 * The two PSM loops on Asset Hub, sized up to `psmMaxTradeUsd`, funded from
 * Asset Hub USDT:
 *   psm-mint    USDT → PSM mint → dotUSD → pool (dotUSD→DOT→USDT): pays when dotUSD > $1
 *   psm-redeem  USDT → pool (USDT→DOT→dotUSD) → PSM redeem → USDT: pays when dotUSD < $1
 */
export async function findPsm(q: Quoter, book: Book, p: Prices, l: Limits, psm: PsmState, observe?: Observe): Promise<Opportunity[]> {
  const ladder = sizeLadder({ minTradeUsd: l.minTradeUsd, maxTradeUsd: l.psmMaxTradeUsd ?? l.maxTradeUsd });
  const usdt = tradeable(book, 'AH', 'USDT');
  const [mint, redeem] = await Promise.all([
    psm.canMint
      ? bestSize(
          ladder,
          async (usd) => {
            const usdtIn = units('USDT', usd, p);
            if (usdtIn < psm.minSwap || usdtIn > psm.mintHeadroom) return null;
            const minted = usdtIn - psmFee(usdtIn, psm.mintFee);
            const usdtOut = await q.ahIn(ahPath('dotUSD', 'USDT'), minted);
            if (!usdtOut) return null;
            return { kind: 'psm-mint', usdtIn, minted, usdtOut, grossUsd: toUsd('USDT', usdtOut - usdtIn, p) };
          },
          (o) => o.kind === 'psm-mint' && o.usdtIn <= usdt,
          observe
        )
      : null,
    psm.canRedeem
      ? bestSize(
          ladder,
          async (usd) => {
            const dotUsd = units('USDT', usd, p); // same 6 decimals, $1 peg
            if (dotUsd < psm.minSwap) return null;
            const usdtIn = await q.ahOut(ahPath('USDT', 'dotUSD'), dotUsd);
            if (!usdtIn) return null;
            const usdtOut = dotUsd - psmFee(dotUsd, psm.redeemFee);
            return { kind: 'psm-redeem', dotUsd, usdtIn, usdtOut, grossUsd: toUsd('USDT', usdtOut - usdtIn, p) };
          },
          (o) => o.kind === 'psm-redeem' && o.usdtIn <= usdt,
          observe
        )
      : null,
  ]);
  return [mint, redeem].filter((o): o is Opportunity => o !== null).sort((a, b) => b.grossUsd - a.grossUsd);
}

/** dotUSD's price on the Asset Hub pool in USDT, from a PSM quote: what selling it fetches (mint) or buying it costs (redeem). */
export function pegPrice(o: Opportunity): { side: 'sell' | 'buy'; price: number } | null {
  if (o.kind === 'psm-mint') return { side: 'sell', price: Number(o.usdtOut) / Number(o.minted) };
  if (o.kind === 'psm-redeem') return { side: 'buy', price: Number(o.usdtIn) / Number(o.dotUsd) };
  return null;
}

/** Cross-chain and PSM candidates together, best first. */
export async function findOpportunities(q: Quoter, book: Book, p: Prices, l: Limits, psm: PsmState | null, observe?: Observe): Promise<Opportunity[]> {
  const [x, m] = await Promise.all([findXchain(q, book, p, l, observe), psm ? findPsm(q, book, p, l, psm, observe) : Promise.resolve([])]);
  return [...x, ...m].sort((a, b) => b.grossUsd - a.grossUsd);
}

/** A few words naming the candidate's route, for the status and cooldowns. */
export function label(o: Opportunity): string {
  if (o.kind === 'xchain') return `${o.base}/${o.quote} sell ${o.sellOn}→buy ${o.buyOn}`;
  return o.kind;
}

export function describe(o: Opportunity, p: Prices): string {
  switch (o.kind) {
    case 'xchain': {
      const b = ASSETS[o.base];
      const qd = ASSETS[o.quote].decimals;
      const size = (Number(o.size) / 10 ** b.decimals).toFixed(b.decimals === 10 ? 4 : 2);
      return (
        `sell ${size} ${o.base} on ${o.sellOn} for ${(Number(o.received) / 10 ** qd).toFixed(4)} ${o.quote}, ` +
        `buy it back on ${o.buyOn} for ${(Number(o.paid) / 10 ** qd).toFixed(4)} ${o.quote} (~$${toUsd(o.base, o.size, p).toFixed(2)})`
      );
    }
    case 'psm-mint':
      return `PSM mint ${(Number(o.usdtIn) / 1e6).toFixed(2)} USDT → dotUSD → sell for ${(Number(o.usdtOut) / 1e6).toFixed(4)} USDT`;
    case 'psm-redeem':
      return `buy ${(Number(o.dotUsd) / 1e6).toFixed(2)} dotUSD for ${(Number(o.usdtIn) / 1e6).toFixed(4)} USDT → PSM redeem → ${(Number(o.usdtOut) / 1e6).toFixed(4)} USDT`;
  }
}

/* ---------------------------------------------------------------- inventory */

export interface RebalancePlan {
  from: Chain;
  items: { sym: Sym; amount: bigint }[];
}

/**
 * XCM transfers only when inventory blocks trading: an asset whose poorer
 * chain can't fund a minimum trade (with margin) while the richer one holds
 * enough to share is moved back to an even split. Transfers in the same
 * direction travel together.
 */
export function planRebalance(book: Book, p: Prices, l: Limits): RebalancePlan[] {
  const plans: Record<Chain, RebalancePlan> = { AH: { from: 'AH', items: [] }, HY: { from: 'HY', items: [] } };
  for (const sym of SYMS) {
    const ah = tradeable(book, 'AH', sym);
    const hy = tradeable(book, 'HY', sym);
    const [rich] = ah >= hy ? (['AH', 'HY'] as const) : (['HY', 'AH'] as const);
    const richAmt = rich === 'AH' ? ah : hy;
    const poorAmt = rich === 'AH' ? hy : ah;
    const floor = 1.5 * l.minTradeUsd;
    if (toUsd(sym, poorAmt, p) >= floor) continue;
    const move = (richAmt - poorAmt) / 2n;
    if (toUsd(sym, move, p) < floor) continue; // not enough on either side to be worth it
    plans[rich].items.push({ sym, amount: move });
  }
  return [plans.AH, plans.HY].filter((pl) => pl.items.length > 0);
}

/* ------------------------------------------------------------- cooldowns */

/**
 * Routes that failed are paused instead of stopping the bot: 1 min after the
 * first failure, doubling with each failure in a row, up to 30 min. A success
 * clears the route; so does a quiet spell of 30 min after its pause ends.
 */
export class Cooldowns {
  private routes = new Map<string, { strikes: number; until: number }>();

  constructor(
    private readonly baseMs = 60_000,
    private readonly maxMs = 30 * 60_000
  ) {}

  /** Record a failure; returns how long the route is now paused and how many failures in a row. */
  fail(route: string, now = Date.now()): { ms: number; strikes: number } {
    const prev = this.routes.get(route);
    const strikes = prev && now < prev.until + this.maxMs ? prev.strikes + 1 : 1;
    const ms = Math.min(this.maxMs, this.baseMs * 2 ** (strikes - 1));
    this.routes.set(route, { strikes, until: now + ms });
    return { ms, strikes };
  }

  ok(route: string): void {
    this.routes.delete(route);
  }

  /** Milliseconds left on the route's pause (0 = free to trade). */
  pausedFor(route: string, now = Date.now()): number {
    const r = this.routes.get(route);
    return r && r.until > now ? r.until - now : 0;
  }

  /** Every paused route with its time left. */
  paused(now = Date.now()): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [route, r] of this.routes) if (r.until > now) out[route] = r.until - now;
    return out;
  }
}
