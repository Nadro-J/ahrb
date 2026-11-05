import { describe, expect, it } from 'vitest';
import type { Sym } from './assets.js';
import type { Book, Prices } from './chains.js';
import { findOpportunities, planRebalance, RESERVE, sizeLadder, tradeable, watchEth, type EthQuoter, type Quoter } from './strategy.js';
import { psmFee, type AhSym, type PsmState } from './venues.js';

const P: Prices = { DOT: 1, USDT: 1, USDC: 1, dotUSD: 1, HDX: 0.01 };
const DEC: Record<AhSym, number> = { DOT: 10, USDT: 6, USDC: 6, dotUSD: 6 };
const LIMITS = { minTradeUsd: 1, maxTradeUsd: 5 };

/**
 * A toy market: each asset has a USD price per chain, every hop costs `fee`
 * and an impact of `impact` per USD traded (so bigger is worse).
 */
function market(ah: Partial<Record<AhSym, number>>, hy: Partial<Record<Sym, number>>, fee = 0.003, impact = 0.0005): Quoter {
  const px = (table: Partial<Record<AhSym, number>>, s: AhSym) => table[s] ?? 1;
  const hop = (table: Partial<Record<AhSym, number>>, from: AhSym, to: AhSym, amountIn: bigint) => {
    const usdIn = (Number(amountIn) / 10 ** DEC[from]) * px(table, from);
    const usdOut = usdIn * (1 - fee) * (1 - impact * usdIn);
    return BigInt(Math.floor((usdOut / px(table, to)) * 10 ** DEC[to]));
  };
  const hopBack = (table: Partial<Record<AhSym, number>>, from: AhSym, to: AhSym, amountOut: bigint) => {
    const usdOut = (Number(amountOut) / 10 ** DEC[to]) * px(table, to);
    const usdIn = usdOut / ((1 - fee) * (1 - impact * usdOut));
    return BigInt(Math.ceil((usdIn / px(table, from)) * 10 ** DEC[from]));
  };
  const walk = (path: AhSym[], amount: bigint) => {
    for (let i = 0; i + 1 < path.length; i++) amount = hop(ah, path[i]!, path[i + 1]!, amount);
    return amount;
  };
  const walkBack = (path: AhSym[], amount: bigint) => {
    for (let i = path.length - 1; i > 0; i--) amount = hopBack(ah, path[i - 1]!, path[i]!, amount);
    return amount;
  };
  return {
    ahIn: async (path, a) => walk(path, a),
    ahOut: async (path, a) => walkBack(path, a),
    hySell: async (f, t, a) => hop(hy, f, t, a),
    hyBuy: async (f, t, a) => hopBack(hy, f, t, a),
  };
}

const usd6 = (v: number) => BigInt(Math.round(v * 1e6));
const dot = (v: number) => BigInt(Math.round(v * 1e10));
function book(ah: [number, number, number], hy: [number, number, number], dotUsd = 0): Book {
  return {
    AH: { DOT: dot(ah[0]), USDT: usd6(ah[1]), USDC: usd6(ah[2]), dotUSD: usd6(dotUsd), HDX: 0n },
    HY: { DOT: dot(hy[0]), USDT: usd6(hy[1]), USDC: usd6(hy[2]), dotUSD: 0n, HDX: 0n },
  };
}
const EVEN = book([7, 7, 7], [7, 7, 7]);

describe('sizeLadder', () => {
  it('walks from the minimum to the cap', () => {
    expect(sizeLadder({ minTradeUsd: 1, maxTradeUsd: 5 })).toEqual([1, 1.5, 2, 3, 4, 5]);
    expect(sizeLadder({ minTradeUsd: 2, maxTradeUsd: 1 })).toEqual([2]);
  });
});

describe('findOpportunities: cross-chain', () => {
  it('finds nothing when the chains agree (fees eat any trade)', async () => {
    expect(await findOpportunities(market({}, {}), EVEN, P, LIMITS, null)).toEqual([]);
  });

  it('shows losing candidates to the observer without returning them', async () => {
    const seen: number[] = [];
    const opps = await findOpportunities(market({}, {}), EVEN, P, LIMITS, null, (o) => seen.push(o.grossUsd));
    expect(opps).toEqual([]);
    expect(seen).toHaveLength(12); // 6 ordered pairs × 2 directions, each stops after its first losing size
    expect(Math.max(...seen)).toBeLessThan(0);
  });

  it('sells DOT where it is dear and buys it back where it is cheap', async () => {
    // DOT 2 % dearer on Hydration.
    const opps = await findOpportunities(market({}, { DOT: 1.02 }), EVEN, P, LIMITS, null);
    const best = opps[0]!;
    expect(best.kind).toBe('xchain');
    if (best.kind !== 'xchain') return;
    expect(best.sellOn).toBe('HY');
    expect(best.buyOn).toBe('AH');
    expect(best.base).toBe('DOT');
    expect(best.received).toBeGreaterThan(best.paid);
    expect(best.grossUsd).toBeGreaterThan(0);
  });

  it('a spread exactly equal to the round-trip pool fees is not an opportunity', async () => {
    // Two hops at 0.3 % each and no impact: a 0.6 % spread leaves nothing (rounding goes against us).
    const spread = 1 / ((1 - 0.003) * (1 - 0.003));
    const opps = await findOpportunities(market({}, { DOT: spread }, 0.003, 0), EVEN, P, LIMITS, null);
    expect(opps.filter((o) => o.kind === 'xchain' && o.base === 'DOT')).toEqual([]);
  });

  it('never sizes past the inventory on either side', async () => {
    // Only ~$2 of tradeable DOT on Hydration.
    const thin = book([7, 7, 7], [2 + Number(RESERVE.HY.DOT) / 1e10, 7, 7]);
    const opps = await findOpportunities(market({}, { DOT: 1.05 }, 0.003, 0), thin, P, LIMITS, null);
    const best = opps.find((o) => o.kind === 'xchain' && o.base === 'DOT' && o.sellOn === 'HY');
    expect(best).toBeDefined();
    if (best?.kind !== 'xchain') return;
    expect(best.size).toBeLessThanOrEqual(tradeable(thin, 'HY', 'DOT'));
    expect(best.paid).toBeLessThanOrEqual(tradeable(thin, 'AH', 'USDT'));
  });

  it('stops growing the size once price impact outweighs the spread', async () => {
    const opps = await findOpportunities(market({}, { DOT: 1.012 }, 0.003, 0.002), EVEN, P, LIMITS, null);
    const best = opps.find((o) => o.kind === 'xchain' && o.base === 'DOT');
    expect(best).toBeDefined();
    if (best?.kind !== 'xchain') return;
    // With 0.2 %/$ impact the optimum is a mid-ladder size, not the $5 cap.
    expect(Number(best.size) / 1e10).toBeLessThan(5);
  });

  it('skips candidates with nothing to sell', async () => {
    const empty = book([0, 7, 7], [0, 7, 7]);
    const opps = await findOpportunities(market({}, { DOT: 1.05 }), empty, P, LIMITS, null);
    expect(opps.filter((o) => o.kind === 'xchain' && o.base === 'DOT')).toEqual([]);
  });
});

describe('findOpportunities: PSM', () => {
  const psm = (over: Partial<PsmState> = {}): PsmState => ({
    mintFee: 0,
    redeemFee: 100,
    canMint: true,
    canRedeem: true,
    minSwap: 1_000_000n,
    mintHeadroom: 10n ** 12n,
    ...over,
  });

  it('mints when dotUSD trades above the peg by more than the pool fees', async () => {
    const opps = await findOpportunities(market({ dotUSD: 1.02 }, {}), EVEN, P, LIMITS, psm());
    expect(opps[0]?.kind).toBe('psm-mint');
  });

  it('redeems when dotUSD trades below the peg', async () => {
    const opps = await findOpportunities(market({ dotUSD: 0.98 }, {}), EVEN, P, LIMITS, psm());
    expect(opps[0]?.kind).toBe('psm-redeem');
  });

  it('respects the circuit breaker, min swap and debt ceiling', async () => {
    const q = market({ dotUSD: 1.02 }, {});
    expect(await findOpportunities(q, EVEN, P, LIMITS, psm({ canMint: false }))).toEqual([]);
    expect(await findOpportunities(q, EVEN, P, LIMITS, psm({ minSwap: 100_000_000n }))).toEqual([]);
    const capped = await findOpportunities(q, EVEN, P, LIMITS, psm({ mintHeadroom: 2_000_000n }));
    expect(capped[0]?.kind === 'psm-mint' && capped[0].usdtIn).toBeLessThanOrEqual(2_000_000n);
  });

  it('psmFee rounds up like Permill::mul_ceil', () => {
    expect(psmFee(1_000_000n, 100)).toBe(100n);
    expect(psmFee(1_000_001n, 100)).toBe(101n);
    expect(psmFee(5_000_000n, 0)).toBe(0n);
  });
});

describe('planRebalance', () => {
  it('leaves balanced inventory alone', () => {
    expect(planRebalance(EVEN, P, LIMITS)).toEqual([]);
  });

  it('moves half the difference when one side is too thin to trade', () => {
    const skewed = book([13, 7, 7], [0.5, 7, 7]);
    const plans = planRebalance(skewed, P, LIMITS);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.from).toBe('AH');
    const item = plans[0]!.items[0]!;
    expect(item.sym).toBe('DOT');
    expect(item.amount).toBe((tradeable(skewed, 'AH', 'DOT') - tradeable(skewed, 'HY', 'DOT')) / 2n);
  });

  it('groups same-direction moves and does nothing when both sides are dust', () => {
    const plans = planRebalance(book([0.5, 0.5, 0.5], [7, 7, 7]), P, LIMITS);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.from).toBe('HY');
    expect(plans[0]!.items.map((i) => i.sym)).toEqual(['DOT', 'USDT', 'USDC']);
    expect(planRebalance(book([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]), P, LIMITS)).toEqual([]);
  });
});

describe('watchEth', () => {
  // ETH at $2000 against DOT at $1; `hyPremium` makes ETH dearer on Hydration. Each leg costs `fee`.
  const quoter = (hyPremium: number, fee = 0.003): EthQuoter => {
    const dot = (usd: number) => BigInt(Math.round(usd * 1e10));
    const usdOf = (eth: bigint, px: number) => (Number(eth) / 1e18) * px;
    return {
      ahSellEth: async (e) => dot(usdOf(e, 2000) * (1 - fee)),
      ahBuyEth: async (e) => dot(usdOf(e, 2000) / (1 - fee)),
      hySellEth: async (e) => dot(usdOf(e, 2000 * (1 + hyPremium)) * (1 - fee)),
      hyBuyEth: async (e) => dot(usdOf(e, 2000 * (1 + hyPremium)) / (1 - fee)),
    };
  };

  it('reports both directions, losing ones at the smallest size', async () => {
    const w = await watchEth(quoter(0), P, LIMITS);
    expect(w.map((x) => x.label).sort()).toEqual(['ETH/DOT sell AH→buy HY', 'ETH/DOT sell HY→buy AH']);
    expect(w.every((x) => x.grossUsd < 0 && x.sizeUsd === 1)).toBe(true);
  });

  it('sells where ETH is dear and walks up the ladder while it pays', async () => {
    const [best] = await watchEth(quoter(0.02), P, LIMITS);
    expect(best!.label).toBe('ETH/DOT sell HY→buy AH');
    expect(best!.grossUsd).toBeGreaterThan(0);
    expect(best!.sizeUsd).toBe(5);
  });
});
