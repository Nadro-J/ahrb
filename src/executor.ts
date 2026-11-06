/**
 * Doing things: the one-time setup, arbs and XCM rebalances. Each runs inside
 * `measured`, which reads both chains' balances before and after and writes
 * the difference to the ledger (see pnl.ts).
 */
import { ASSETS, CHAIN_NAME, fmt, native, SYMS, type Chain, type Sym } from './assets.js';
import { deltaUsd, dryRun, readBook, readPrices, send, sleep, usdOf, type Book, type Chains, type Prices, type Sent, type Tx, type Wallet } from './chains.js';
import { c as color, log, usd, usdColored } from './log.js';
import type { ActionKind, Ledger } from './pnl.js';
import { describe, RESERVE, type Opportunity, type RebalancePlan } from './strategy.js';
import {
  ahBatchAll,
  ahPath,
  ahQuoteIn,
  ahQuoteOut,
  ahSwapIn,
  ahSwapOut,
  hyBuy,
  hyFeeCurrency,
  hySell,
  hySetFeeCurrency,
  hyTradeTx,
  psmMint,
  psmRedeem,
  type PsmState,
  xcmMessages as messages,
  type XcmItem,
  xcmTransfer,
} from './venues.js';

export interface Ctx {
  c: Chains;
  w: Wallet;
  ledger: Ledger;
  minProfitUsd: number;
}

/** Thrown when the bot must stop (stuck XCM etc.). */
export class Halt extends Error {}

const units = (sym: Sym, usdValue: number, p: Prices) => native(usdValue / p[sym], ASSETS[sym].decimals);
const toUsd = (sym: Sym, amount: bigint, p: Prices) => (Number(amount) / 10 ** ASSETS[sym].decimals) * p[sym];

/** Run `fn`, measure the book on both sides of it, and record the outcome. */
async function measured(
  ctx: Ctx,
  kind: ActionKind,
  what: string,
  fn: (txs: Sent[], prices: Prices) => Promise<{ expectedUsd?: number } | void>
): Promise<{ ok: boolean; realizedUsd: number; error?: string }> {
  const [before, prices] = await Promise.all([readBook(ctx.c, ctx.w), readPrices(ctx.c)]);
  const txs: Sent[] = [];
  let ok = true;
  let error: string | undefined;
  let expectedUsd: number | undefined;
  try {
    expectedUsd = (await fn(txs, prices))?.expectedUsd;
  } catch (e) {
    ok = false;
    error = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ');
  }
  const after = await readBook(ctx.c, ctx.w);
  const realizedUsd = deltaUsd(before, after, prices);
  ctx.ledger.record({ ts: new Date().toISOString(), kind, what, expectedUsd, realizedUsd, ok, error, txs, prices, before, after });
  const tag = color.bold(kind.toUpperCase());
  if (ok) log.ok(`${tag} ${what} → realized ${usdColored(realizedUsd)}${expectedUsd !== undefined ? color.dim(` (expected ${usd(expectedUsd)})`) : ''}`);
  else log.error(`${tag} ${what} failed: ${error} → realized ${usdColored(realizedUsd)}`);
  if (error && error.startsWith('HALT:')) throw new Halt(error.slice(5).trim());
  return { ok, realizedUsd, error };
}

/** Fee for `tx` in USD: Asset Hub quotes DOT, Hydration quotes HDX (charged in the account's fee currency). */
async function feeUsd(ctx: Ctx, chain: Chain, tx: Tx, p: Prices): Promise<number> {
  const fee: bigint = await tx.getEstimatedFees(chain === 'AH' ? ctx.w.ah : ctx.w.hy);
  return chain === 'AH' ? (Number(fee) / 1e10) * p.DOT : (Number(fee) / 1e12) * p.HDX;
}

/* ================================================================ XCM */

/** Poll the destination until every item has (nearly) arrived. Throws a halt after `timeoutMs`. */
async function waitArrival(ctx: Ctx, dest: Chain, before: Book, items: XcmItem[], timeoutMs = 10 * 60_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(6_000);
    const now = await readBook(ctx.c, ctx.w);
    // Destination execution fees come out of the transferred asset; they are well under 1 %.
    if (items.every((i) => now[dest][i.sym] - before[dest][i.sym] >= (i.amount * 97n) / 100n)) {
      log.ok(`XCM arrived on ${CHAIN_NAME[dest]} after ${Math.round((Date.now() - start) / 1000)}s`);
      return;
    }
  }
  throw new Error(`HALT: XCM to ${CHAIN_NAME[dest]} not seen after ${timeoutMs / 60_000} min — check the account on a block explorer before restarting`);
}

async function xcm(ctx: Ctx, kind: ActionKind, from: Chain, items: XcmItem[]): Promise<boolean> {
  const dest: Chain = from === 'AH' ? 'HY' : 'AH';
  const what = `XCM ${from}→${dest} ${items.map((i) => `${fmt(i.amount, ASSETS[i.sym].decimals)} ${i.sym}`).join(' + ')}`;
  const res = await measured(ctx, kind, what, async (txs) => {
    const before = await readBook(ctx.c, ctx.w);
    txs.push(await send(ctx.c, ctx.w, from, what, xcmTransfer(ctx.c, ctx.w, from, items)));
    await waitArrival(ctx, dest, before, items);
  });
  return res.ok;
}


export async function rebalance(ctx: Ctx, plans: RebalancePlan[]): Promise<void> {
  for (const plan of plans) for (const msg of messages(plan.items)) await xcm(ctx, 'rebalance', plan.from, msg);
}

/* ============================================================== bootstrap */

/** Per-asset, per-chain inventory target: equity split evenly over every asset on both chains. */
export const inventoryTarget = (equityUsd: number) => equityUsd / (2 * SYMS.length);

/**
 * Assets the account barely holds (under a quarter of the target across both
 * chains), e.g. one newly added to SYMS after the first setup. `bootstrap`
 * with this list sets up just those.
 */
export function missingAssets(book: Book, p: Prices): Sym[] {
  const target = inventoryTarget(usdOf(book, p));
  return SYMS.filter((s) => toUsd(s, book.AH[s] + book.HY[s], p) < target / 2);
}

/**
 * Turn the starting balance into even inventory: equity / 8 in each of DOT,
 * USDT, USDC and ETH on each chain. Bought on Asset Hub with USDT, then half
 * of each sent to Hydration. Safe to re-run: each step tops up only what is
 * missing. With `only`, sets up just those assets (and spends only the USDT
 * the account can spare), so an asset added later doesn't redo the rest.
 */
export async function bootstrap(ctx: Ctx, only?: Sym[]): Promise<void> {
  const { c, w } = ctx;
  const wanted = (s: Sym) => !only || only.includes(s);
  let [book, p] = await Promise.all([readBook(c, w), readPrices(c)]);
  const equity = usdOf(book, p);
  const target = inventoryTarget(equity);
  const which = only ? only.join('/') : SYMS.join('/');
  log.step(`setup: equity $${equity.toFixed(2)} → target ~$${target.toFixed(2)} of each of ${which} on each chain`);

  // 1. DOT on Asset Hub for both chains (+ the fee reserve). Fees are paid in USDT until the account holds DOT.
  // Holdings on both chains count, so a restart after the XCM step buys nothing twice.
  const wantDot = units('DOT', 2 * target, p) + RESERVE.AH.DOT;
  const haveDot = book.AH.DOT + book.HY.DOT;
  if (wanted('DOT') && haveDot < (wantDot * 95n) / 100n) {
    const buy = wantDot - haveDot;
    const quote = await ahQuoteOut(c, ['USDT', 'DOT'], buy);
    if (!quote) throw new Error('setup: no Asset Hub quote for USDT→DOT');
    const maxIn = (quote * 101n) / 100n;
    const res = await measured(ctx, 'setup', `buy ${fmt(buy, 10)} DOT for ≤${fmt(maxIn, 6, 2)} USDT on AH`, async (txs) => {
      const feeAsset = book.AH.DOT < native(0.05, 10) ? ASSETS.USDT.ahLocation : undefined;
      txs.push(await send(c, w, 'AH', 'swap USDT→DOT', ahSwapOut(c, w, ['USDT', 'DOT'], buy, maxIn), { feeAsset }));
    });
    if (!res.ok) throw new Halt('setup: buying DOT failed (see above) — fix and restart, setup resumes where it stopped');
    book = await readBook(c, w);
  }

  // 2. The other assets on Asset Hub for both chains, bought with USDT (USDT → DOT → X).
  for (const sym of SYMS.filter((s) => s !== 'DOT' && s !== 'USDT' && wanted(s))) {
    const want = units(sym, 2 * target, p) + RESERVE.AH[sym] + RESERVE.HY[sym];
    const have = book.AH[sym] + book.HY[sym];
    if (have >= (want * 95n) / 100n) continue;
    // Spend only USDT the account can spare: its reserve and $1 stay.
    const spare = book.AH.USDT - RESERVE.AH.USDT - units('USDT', 1, p);
    const needUsd = toUsd(sym, want - have, p);
    const spendUsd = Math.min(needUsd, spare > 0n ? toUsd('USDT', spare, p) : 0);
    if (spendUsd < 1) {
      log.warn(`setup: not enough spare USDT on Asset Hub to buy ${sym} (needs ~$${needUsd.toFixed(2)}): send USDT to ${w.ah} and restart`);
      continue;
    }
    if (spendUsd < needUsd * 0.95) log.warn(`setup: buying only $${spendUsd.toFixed(2)} of ${sym} (target $${needUsd.toFixed(2)}): add USDT for the rest`);
    const spend = units('USDT', spendUsd, p);
    const out = await ahQuoteIn(c, ahPath('USDT', sym), spend);
    if (!out) throw new Error(`setup: no Asset Hub quote for USDT→${sym}`);
    const minOut = (out * 99n) / 100n;
    const d = ASSETS[sym].decimals;
    const res = await measured(ctx, 'setup', `swap ${fmt(spend, 6, 2)} USDT → ≥${fmt(minOut, d, d > 6 ? 6 : 2)} ${sym} on AH`, async (txs) => {
      txs.push(await send(c, w, 'AH', `swap USDT→${sym}`, ahSwapIn(c, w, ahPath('USDT', sym), spend, minOut)));
    });
    if (!res.ok) throw new Halt(`setup: buying ${sym} failed (see above) — fix and restart, setup resumes where it stopped`);
    book = await readBook(c, w);
  }

  // 3. Hydration's half of each asset. Up to the target when Asset Hub holds more than it, else an even split
  //    (an asset bought short of its target still ends up on both chains). xcmMessages groups them.
  p = await readPrices(c);
  const items: XcmItem[] = SYMS.filter(wanted).map((sym) => {
    const missing = units(sym, target, p) - book.HY[sym];
    const aboveTarget = book.AH[sym] - (units(sym, target, p) + RESERVE.AH[sym]);
    const halfGap = (book.AH[sym] - RESERVE.AH[sym] - book.HY[sym]) / 2n;
    const room = aboveTarget > halfGap ? aboveTarget : halfGap;
    return { sym, amount: missing > 0n && room > 0n ? (missing < room ? missing : room) : 0n };
  }).filter((i) => toUsd(i.sym, i.amount, p) >= 0.5);
  for (const msg of messages(items)) {
    if (!(await xcm(ctx, 'setup', 'AH', msg))) throw new Halt('setup: XCM to Hydration failed (see above) — fix and restart');
  }

  await ensureHydrationFeeCurrency(ctx);
  if (!only) {
    ctx.ledger.state.bootstrapped = true;
    ctx.ledger.save();
  }
  log.ok('setup complete');
}

/** Hydration charges fees in HDX unless the account picked another currency; we hold none, so pay in DOT. */
export async function ensureHydrationFeeCurrency(ctx: Ctx): Promise<void> {
  const current = await hyFeeCurrency(ctx.c, ctx.w);
  const book = await readBook(ctx.c, ctx.w);
  const hasCurrency = current !== undefined && current !== 0;
  if (hasCurrency || book.HY.HDX > native(1, 12)) {
    log.info(`Hydration fee currency: ${current === undefined || current === 0 ? 'HDX' : (SYMS.find((s) => ASSETS[s].hyId === current) ?? `asset ${current}`)}`);
    return;
  }
  const res = await measured(ctx, 'setup', 'set Hydration fee currency to DOT', async (txs) => {
    txs.push(await send(ctx.c, ctx.w, 'HY', 'set fee currency DOT', hySetFeeCurrency(ctx.c, ASSETS.DOT.hyId)));
  });
  if (!res.ok) {
    throw new Halt(
      `Hydration can't charge fees to ${ctx.w.hy}: it has no fee currency and no HDX. ` +
        `Send it ~1 HDX, or pick DOT as fee currency in the Hydration app, then restart.`
    );
  }
}

/* ==================================================================== arbs */

export type ArbOutcome = { outcome: 'ok' } | { outcome: 'failed'; error: string; realizedUsd: number } | { outcome: 'skipped'; reason: string };

/**
 * Execute an opportunity if it still clears every cost. 'skipped' means
 * nothing was sent (stale, or below the profit floor once fees are known);
 * the caller decides whether to print the reason.
 */
export async function executeArb(ctx: Ctx, o: Opportunity, p: Prices, psm: PsmState | null): Promise<ArbOutcome> {
  const plan = o.kind === 'xchain' ? await planXchain(ctx, o, p) : await planPsm(ctx, o, p, psm);
  if (typeof plan === 'string') return { outcome: 'skipped', reason: plan };
  const res = await measured(ctx, 'arb', describe(o, p), async (txs) => {
    await plan.run(txs);
    return { expectedUsd: plan.netUsd };
  });
  return res.ok ? { outcome: 'ok' } : { outcome: 'failed', error: res.error ?? 'unknown error', realizedUsd: res.realizedUsd };
}

interface Plan {
  netUsd: number;
  run(txs: Sent[]): Promise<void>;
}

/**
 * Both legs, with limits that keep the pair profitable even if each leg fills
 * at its worst allowed price: 40 % of the expected net is given to each
 * leg's slippage, 20 % is kept.
 */
async function planXchain(ctx: Ctx, o: Extract<Opportunity, { kind: 'xchain' }>, p: Prices): Promise<Plan | string> {
  const { c, w } = ctx;
  const build = async (slack: bigint): Promise<[Tx, Tx] | string> => {
    let sellTx: Tx | null;
    if (o.sellOn === 'AH') sellTx = ahSwapIn(c, w, ahPath(o.base, o.quote), o.size, o.received - slack);
    else {
      const t = await hySell(c, o.base, o.quote, o.size);
      sellTx = t && (await hyTradeTx(c, w, t, o.received - slack));
    }
    let buyTx: Tx | null;
    if (o.buyOn === 'AH') buyTx = ahSwapOut(c, w, ahPath(o.quote, o.base), o.size, o.paid + slack);
    else {
      const t = await hyBuy(c, o.quote, o.base, o.size);
      buyTx = t && (await hyTradeTx(c, w, t, o.paid + slack));
    }
    if (!sellTx || !buyTx) return 'Hydration price moved before execution';
    return [sellTx, buyTx];
  };

  const spread = o.received - o.paid;
  const draft = await build(spread / 10n > 0n ? spread / 10n : 1n);
  if (typeof draft === 'string') return draft;
  const fees = (await feeUsd(ctx, o.sellOn, draft[0], p)) + (await feeUsd(ctx, o.buyOn, draft[1], p));
  const netUsd = o.grossUsd - fees;
  if (netUsd < ctx.minProfitUsd) return `gross ${usd(o.grossUsd)} − tx fees $${fees.toFixed(4)} = ${usd(netUsd)} < min profit $${ctx.minProfitUsd}`;

  const netQuote = spread - units(o.quote, fees, p);
  const slack = (netQuote * 2n) / 5n;
  const legs = await build(slack);
  if (typeof legs === 'string') return legs;

  return {
    netUsd,
    async run(txs) {
      const [sellTx, buyTx] = legs;
      const sellAddr = o.sellOn === 'AH' ? w.ah : w.hy;
      const buyAddr = o.buyOn === 'AH' ? w.ah : w.hy;
      // Both legs must pass a dry run before either is signed.
      await Promise.all([
        dryRun(o.sellOn === 'AH' ? c.ah : c.hy, sellAddr, sellTx),
        dryRun(o.buyOn === 'AH' ? c.ah : c.hy, buyAddr, buyTx),
      ]);
      const results = await Promise.allSettled([
        send(c, w, o.sellOn, `sell ${o.base}→${o.quote}`, sellTx, { dryRunDone: true }),
        send(c, w, o.buyOn, `buy ${o.quote}→${o.base}`, buyTx, { dryRunDone: true }),
      ]);
      for (const r of results) if (r.status === 'fulfilled') txs.push(r.value);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed.length) throw new Error(failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join('; '));
    },
  };
}

/** PSM loops: one batch_all on Asset Hub, the swap's limit set so the batch can't lose more than half the expected net. */
async function planPsm(ctx: Ctx, o: Exclude<Opportunity, { kind: 'xchain' }>, p: Prices, psm: PsmState | null): Promise<Plan | string> {
  const { c, w } = ctx;
  if (!psm) return 'PSM unavailable';
  const build = (slack: bigint): Tx =>
    o.kind === 'psm-mint'
      ? ahBatchAll(c, [psmMint(c, o.usdtIn, psm.mintFee), ahSwapIn(c, w, ahPath('dotUSD', 'USDT'), o.minted, o.usdtOut - slack, false)])
      : ahBatchAll(c, [ahSwapOut(c, w, ahPath('USDT', 'dotUSD'), o.dotUsd, o.usdtIn + slack), psmRedeem(c, o.dotUsd, psm.redeemFee)]);
  const fees = await feeUsd(ctx, 'AH', build(0n), p);
  const netUsd = o.grossUsd - fees;
  if (netUsd < ctx.minProfitUsd) return `gross ${usd(o.grossUsd)} − tx fee $${fees.toFixed(4)} = ${usd(netUsd)} < min profit $${ctx.minProfitUsd}`;
  const gross = o.usdtOut - o.usdtIn;
  const slack = (gross - units('USDT', fees, p)) / 2n;
  const tx = build(slack);
  return {
    netUsd,
    async run(txs) {
      txs.push(await send(c, w, 'AH', o.kind, tx));
    },
  };
}

/** For the status line: DOT priced in USDT on each chain. */
export async function dotPrices(ctx: Ctx, p: Prices): Promise<{ ah: number; hy: number | null }> {
  const spot = await ctx.c.sdk.api.router.getSpotPrice(ASSETS.DOT.hyId, ASSETS.USDT.hyId).catch(() => undefined);
  return { ah: p.DOT, hy: spot && spot.amount > 0n ? Number(spot.amount) / 10 ** spot.decimals : null };
}


/**
 * Network fees of a typical cross-chain round trip: a $1 DOT→USDT swap on
 * Asset Hub plus a $1 USDT→DOT trade on Hydration, estimated from real
 * transactions (nothing is sent). For the "needed" line in the status chart.
 */
export async function typicalXchainFees(ctx: Ctx, p: Prices): Promise<number | null> {
  const { c, w } = ctx;
  const ahTx = ahSwapIn(c, w, ahPath('DOT', 'USDT'), units('DOT', 1, p), 1n);
  const t = await hySell(c, 'USDT', 'DOT', units('USDT', 1, p));
  const hyTx = t && (await hyTradeTx(c, w, t, (t.amountOut * 99n) / 100n));
  if (!hyTx) return null;
  return (await feeUsd(ctx, 'AH', ahTx, p)) + (await feeUsd(ctx, 'HY', hyTx, p));
}
