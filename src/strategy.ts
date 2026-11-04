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
 *               Every ordered pair of DOT/USDT/USDC in both chain
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
}

/** Balance kept back from trading on each chain: fees, existential deposits, XCM delivery. */
export const RESERVE: Record<Chain, Record<Sym, bigint>> = {
  AH: { DOT: native(0.15, 10), USDT: native(0.02, 6), USDC: native(0.02, 6) },
  HY: { DOT: native(0.05, 10), USDT: native(0.02, 6), USDC: native(0.02, 6) },
};

export function tradeable(book: Book, chain: Chain, sym: Sym): bigint {
  const v = book[chain][sym] - RESERVE[chain][sym];
  return v > 0n ? v : 0n;
}

/** Trade sizes to try, in USD: a ladder from the minimum up to the cap. */
export function sizeLadder(l: Limits): number[] {
  const steps = [1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20];
  const ladder = steps.map((s) => s * l.minTradeUsd).filter((s) => s <= l.maxTradeUsd + 1e-9);
  return ladder.length ? ladder : [l.minTradeUsd];
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

/**
 * Every candidate, screened at the smallest size; the ones in profit there
 * are walked up the size ladder and the most profitable size is kept.
 * Candidates the inventory can't fund are skipped. `observe` sees every
 * fundable quote, losing ones included (the status line shows the closest).
 */
export async function findOpportunities(
  q: Quoter,
  book: Book,
  p: Prices,
  l: Limits,
  psm: PsmState | null,
  observe?: (o: Opportunity) => void
): Promise<Opportunity[]> {
  const ladder = sizeLadder(l);
  const found: Opportunity[] = [];

  const best = async (sizes: number[], quoteAt: (usd: number) => Promise<Opportunity | null>, fits: (o: Opportunity) => boolean) => {
    let top: Opportunity | null = null;
    for (const usd of sizes) {
      const o = await quoteAt(usd).catch(() => null);
      if (!o || !fits(o)) break; // bigger only gets worse once inventory or the pools run out
      observe?.(o);
      if (o.grossUsd <= 0) break; // slippage grows with size: past break-even it never comes back
      if (!top || o.grossUsd > top.grossUsd) top = o;
    }
    if (top) found.push(top);
  };

  for (const sellOn of CHAINS) {
    for (const base of SYMS) {
      for (const quote of SYMS) {
        if (base === quote) continue;
        const buyOn = other(sellOn);
        await best(
          ladder,
          (usd) => quoteXchain(q, sellOn, base, quote, units(base, usd, p), p),
          (o) =>
            o.kind === 'xchain' &&
            o.size <= tradeable(book, sellOn, base) &&
            o.paid <= tradeable(book, buyOn, quote) &&
            o.size > 0n
        );
      }
    }
  }

  if (psm) {
    const usdt = tradeable(book, 'AH', 'USDT');
    if (psm.canMint) {
      await best(
        ladder,
        async (usd) => {
          const usdtIn = units('USDT', usd, p);
          if (usdtIn < psm.minSwap || usdtIn > psm.mintHeadroom) return null;
          const minted = usdtIn - psmFee(usdtIn, psm.mintFee);
          const usdtOut = await q.ahIn(ahPath('dotUSD', 'USDT'), minted);
          if (!usdtOut) return null;
          return { kind: 'psm-mint', usdtIn, minted, usdtOut, grossUsd: toUsd('USDT', usdtOut - usdtIn, p) };
        },
        (o) => o.kind === 'psm-mint' && o.usdtIn <= usdt
      );
    }
    if (psm.canRedeem) {
      await best(
        ladder,
        async (usd) => {
          const dotUsd = units('USDT', usd, p); // same 6 decimals, $1 peg
          if (dotUsd < psm.minSwap) return null;
          const usdtIn = await q.ahOut(ahPath('USDT', 'dotUSD'), dotUsd);
          if (!usdtIn) return null;
          const usdtOut = dotUsd - psmFee(dotUsd, psm.redeemFee);
          return { kind: 'psm-redeem', dotUsd, usdtIn, usdtOut, grossUsd: toUsd('USDT', usdtOut - usdtIn, p) };
        },
        (o) => o.kind === 'psm-redeem' && o.usdtIn <= usdt
      );
    }
  }

  return found.sort((a, b) => b.grossUsd - a.grossUsd);
}

/** A few words naming the candidate, for the status line. */
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
