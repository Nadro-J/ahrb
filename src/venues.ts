/**
 * The three ways the bot moves value, each as quote functions plus transaction builders:
 *
 *   Asset Hub   pallet-asset-conversion (DOT-paired pools, 0.3 % LP fee) and
 *               pallet-psm (USDT ⇄ dotUSD at 1:1 minus the live mint/redeem fee)
 *   Hydration   the Galactic SDK router (Omnipool / stableswap / XYK)
 *   XCM         PolkadotXcm.transfer_assets_using_type_and_then: LocalReserve
 *               from Asset Hub (the reserve for DOT, USDT and USDC), and
 *               DestinationReserve back from Hydration. Every combination was
 *               dry-run on both ends on 2026-11-03 (source dry_run_call, then
 *               the forwarded message through the destination's dry_run_xcm).
 */
import type { sor } from '@galacticcouncil/sdk-next';
import { ASSET_HUB_PARA, ASSETS, DOT_LOCATION, DOTUSD, HYDRATION_PARA, xcmSortKey, type Chain, type Location, type Sym } from './assets.js';
import { BEST, type Chains, type Tx, type Wallet } from './chains.js';

type Trade = sor.Trade;

/* ================================================================ Asset Hub */

export type AhSym = Sym | 'dotUSD';
const ahLoc = (s: AhSym): Location => (s === 'dotUSD' ? DOTUSD.location : ASSETS[s].ahLocation);

/** Every Asset Hub pool pairs with DOT, so a non-DOT pair routes through it. */
export function ahPath(from: AhSym, to: AhSym): AhSym[] {
  return from === 'DOT' || to === 'DOT' ? [from, to] : [from, 'DOT', to];
}

/** Exact-in quote along a path (fees included); null when a pool can't price it. */
export async function ahQuoteIn(c: Chains, path: AhSym[], amountIn: bigint): Promise<bigint | null> {
  let amount = amountIn;
  for (let i = 0; i + 1 < path.length; i++) {
    const q = (await c.ah.apis.AssetConversionApi.quote_price_exact_tokens_for_tokens(ahLoc(path[i]!), ahLoc(path[i + 1]!), amount, true, BEST)) as
      | bigint
      | undefined;
    if (!q) return null;
    amount = q;
  }
  return amount;
}

/** Exact-out quote along a path: the input needed for `amountOut` (fees included). */
export async function ahQuoteOut(c: Chains, path: AhSym[], amountOut: bigint): Promise<bigint | null> {
  let amount = amountOut;
  for (let i = path.length - 1; i > 0; i--) {
    const q = (await c.ah.apis.AssetConversionApi.quote_price_tokens_for_exact_tokens(ahLoc(path[i - 1]!), ahLoc(path[i]!), amount, true, BEST)) as
      | bigint
      | undefined;
    if (!q) return null;
    amount = q;
  }
  return amount;
}

/**
 * `keepAlive` protects the account's balance of the asset sold from going
 * under its existential deposit (Preserve). Selling all of an asset — the
 * whole freshly minted dotUSD in the PSM loop — needs it off, or the pallet
 * refuses with Token.NotExpendable.
 */
export function ahSwapIn(c: Chains, w: Wallet, path: AhSym[], amountIn: bigint, minOut: bigint, keepAlive = true): Tx {
  return c.ah.tx.AssetConversion.swap_exact_tokens_for_tokens({
    path: path.map(ahLoc),
    amount_in: amountIn,
    amount_out_min: minOut,
    send_to: w.ah,
    keep_alive: keepAlive,
  });
}

export function ahSwapOut(c: Chains, w: Wallet, path: AhSym[], amountOut: bigint, maxIn: bigint): Tx {
  return c.ah.tx.AssetConversion.swap_tokens_for_exact_tokens({
    path: path.map(ahLoc),
    amount_out: amountOut,
    amount_in_max: maxIn,
    send_to: w.ah,
    keep_alive: true,
  });
}

export function ahBatchAll(c: Chains, txs: Tx[]): Tx {
  return c.ah.tx.Utility.batch_all({ calls: txs.map((t) => t.decodedCall) });
}

/* ---------------------------------------------------------------------- PSM */

export interface PsmState {
  /** Parts per million. */
  mintFee: number;
  redeemFee: number;
  canMint: boolean;
  canRedeem: boolean;
  minSwap: bigint;
  /** How much more USDT the PSM will take in before the ceiling (ExceedsMaxPsmDebt). */
  mintHeadroom: bigint;
}

/** Live PSM state for dotUSD ⇄ USDT; null when the PSM or the pair does not exist. */
export async function psmState(c: Chains): Promise<PsmState | null> {
  const q = c.ah.query.Psm;
  const [info, mintFee, redeemFee, ext, debt, weight] = await Promise.all([
    q.Psm.getValue(DOTUSD.location, BEST),
    q.MintingFee.getValue(DOTUSD.location, ASSETS.USDT.ahLocation, BEST),
    q.RedemptionFee.getValue(DOTUSD.location, ASSETS.USDT.ahLocation, BEST),
    q.ExternalAssets.getValue(DOTUSD.location, ASSETS.USDT.ahLocation, BEST),
    q.PsmDebt.getValue(DOTUSD.location, ASSETS.USDT.ahLocation, BEST),
    q.AssetCeilingWeight.getValue(DOTUSD.location, ASSETS.USDT.ahLocation, BEST),
  ]);
  if (!info || !ext) return null;
  const status: string = ext.status.type;
  const ceiling = ((info.max_debt as bigint) * BigInt(weight ?? 0)) / 1_000_000n;
  const used = (debt as bigint | undefined) ?? 0n;
  return {
    mintFee: mintFee ?? 0,
    redeemFee: redeemFee ?? 0,
    canMint: status === 'AllEnabled',
    canRedeem: status === 'AllEnabled' || status === 'MintingDisabled',
    minSwap: info.min_swap_amount,
    mintHeadroom: ceiling > used ? ceiling - used : 0n,
  };
}

/** The PSM fee on `amount` (Permill::mul_ceil, taken in dotUSD). */
export const psmFee = (amount: bigint, ppm: number) => (amount * BigInt(ppm) + 999_999n) / 1_000_000n;

export function psmMint(c: Chains, usdtIn: bigint, maxFeePpm: number): Tx {
  return c.ah.tx.Psm.mint({
    internal_asset: DOTUSD.location,
    external_asset: ASSETS.USDT.ahLocation,
    external_amount: usdtIn,
    max_fee: maxFeePpm,
  });
}

export function psmRedeem(c: Chains, dotUsdIn: bigint, maxFeePpm: number): Tx {
  return c.ah.tx.Psm.redeem({
    internal_asset: DOTUSD.location,
    external_asset: ASSETS.USDT.ahLocation,
    internal_amount: dotUsdIn,
    max_fee: maxFeePpm,
  });
}

/* ================================================================ Hydration */

/** A router trade the pools can actually fill, or null. */
function usable(t: Trade | undefined): Trade | null {
  if (!t || t.amountIn <= 0n || t.amountOut <= 0n) return null;
  if (t.swaps.some((s) => (s as { errors?: unknown[] }).errors?.length)) return null;
  return t;
}

/** A Hydration asset by registry id and decimals. */
type HyAsset = { id: number; decimals: number };
const hyAsset = (s: Sym): HyAsset => ({ id: ASSETS[s].hyId, decimals: ASSETS[s].decimals });

async function hySellIds(c: Chains, from: HyAsset, to: HyAsset, amountIn: bigint): Promise<Trade | null> {
  return usable(await c.sdk.api.router.getBestSell(from.id, to.id, amountIn).catch(() => undefined));
}

async function hyBuyIds(c: Chains, from: HyAsset, to: HyAsset, amountOut: bigint): Promise<Trade | null> {
  const t = usable(await c.sdk.api.router.getBestBuy(from.id, to.id, amountOut).catch(() => undefined));
  // An exact-out the pools can't deliver comes back as a near-free dust trade: reject anything under half of spot.
  if (t && t.spotPrice > 0n) {
    const atSpot = (amountOut * t.spotPrice * 10n ** BigInt(from.decimals)) / 10n ** BigInt(to.decimals + 18);
    if (t.amountIn * 2n < atSpot) return null;
  }
  return t;
}

export const hySell = (c: Chains, from: Sym, to: Sym, amountIn: bigint) => hySellIds(c, hyAsset(from), hyAsset(to), amountIn);
export const hyBuy = (c: Chains, from: Sym, to: Sym, amountOut: bigint) => hyBuyIds(c, hyAsset(from), hyAsset(to), amountOut);

/**
 * The router transaction for `trade` with its limit set to `limit` (min out
 * for a sell, max in for a buy). The SDK takes slippage in whole basis
 * points, so the percentage is rounded towards the safe side.
 * Returns null when the limit is tighter than the fresh quote allows.
 */
export async function hyTradeTx(c: Chains, w: Wallet, trade: Trade, limit: bigint): Promise<Tx | null> {
  const sell = trade.type === 'Sell';
  const room = sell ? trade.amountOut - limit : limit - trade.amountIn;
  const base = sell ? trade.amountOut : trade.amountIn;
  if (room <= 0n) return null;
  const bps = Number((room * 10_000n) / base); // floor = never looser than `limit`
  if (bps < 1) return null;
  const tx = await c.sdk.tx.trade(trade).withBeneficiary(w.hy).withSlippage(Math.min(bps, 5_000) / 100).build();
  return tx.get() as Tx;
}

/** Hydration's fee currency for the account (undefined = HDX). */
export async function hyFeeCurrency(c: Chains, w: Wallet): Promise<number | undefined> {
  return c.hy.query.MultiTransactionPayment.AccountCurrencyMap.getValue(w.hy);
}

export function hySetFeeCurrency(c: Chains, assetId: number): Tx {
  return c.hy.tx.MultiTransactionPayment.set_currency({ currency: assetId });
}

/* ====================================================================== XCM */

export interface XcmItem {
  sym: Sym;
  amount: bigint;
}

/** pallet-xcm refuses more than this many assets in one transfer (TooManyAssets). */
export const XCM_MAX_ASSETS = 2;

/** Assets that only travel alone: their paths were verified by dry run as single-asset messages only. */
const TRAVELS_ALONE: Sym[] = ['ETH'];

/**
 * Items grouped into messages: at most XCM_MAX_ASSETS each, DOT first (it pays
 * the destination fee for its message), and ETH always on its own. ETH paid
 * its own destination fee in both directions when dry-run on 2026-11-05
 * (`npm run verify-xcm -- ETH`); ETH paired with DOT could not be checked
 * from Hydration.
 */
export function xcmMessages(items: XcmItem[]): XcmItem[][] {
  const alone = items.filter((i) => TRAVELS_ALONE.includes(i.sym));
  const rest = items.filter((i) => !TRAVELS_ALONE.includes(i.sym)).sort((a, b) => Number(b.sym === 'DOT') - Number(a.sym === 'DOT'));
  const out: XcmItem[][] = [];
  for (let i = 0; i < rest.length; i += XCM_MAX_ASSETS) out.push(rest.slice(i, i + XCM_MAX_ASSETS));
  return [...out, ...alone.map((i) => [i])];
}

/**
 * One XCM carrying up to two items from `from` to the other chain;
 * destination fees are paid in DOT when it travels, else the first asset.
 */
export function xcmTransfer(c: Chains, w: Wallet, from: Chain, items: XcmItem[]): Tx {
  const sorted = items.filter((i) => i.amount > 0n).sort((a, b) => xcmSortKey(from, a.sym) - xcmSortKey(from, b.sym));
  if (!sorted.length) throw new Error('xcmTransfer: nothing to send');
  if (sorted.length > XCM_MAX_ASSETS) throw new Error(`xcmTransfer: at most ${XCM_MAX_ASSETS} assets per message`);
  const loc = (s: Sym) => (from === 'AH' ? ASSETS[s].ahLocation : ASSETS[s].hyLocation);
  const feeSym = sorted.some((i) => i.sym === 'DOT') ? 'DOT' : sorted[0]!.sym;
  const destPara = from === 'AH' ? HYDRATION_PARA : ASSET_HUB_PARA;
  const transferType = { type: from === 'AH' ? 'LocalReserve' : 'DestinationReserve' };
  const beneficiary = {
    parents: 0,
    interior: { type: 'X1', value: { type: 'AccountId32', value: { network: undefined, id: w.accountId } } },
  };
  const api = from === 'AH' ? c.ah : c.hy;
  return api.tx.PolkadotXcm.transfer_assets_using_type_and_then({
    dest: { type: 'V5', value: { parents: 1, interior: { type: 'X1', value: { type: 'Parachain', value: destPara } } } },
    assets: { type: 'V5', value: sorted.map((i) => ({ id: loc(i.sym), fun: { type: 'Fungible', value: i.amount } })) },
    assets_transfer_type: transferType,
    remote_fees_id: { type: 'V5', value: feeSym === 'DOT' ? DOT_LOCATION : loc(feeSym) },
    fees_transfer_type: transferType,
    custom_xcm_on_dest: {
      type: 'V5',
      value: [{ type: 'DepositAsset', value: { assets: { type: 'Wild', value: { type: 'AllCounted', value: sorted.length } }, beneficiary } }],
    },
    weight_limit: { type: 'Unlimited' },
  });
}
