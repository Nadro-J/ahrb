/**
 * The assets the bot trades, as each chain names them. Verified on-chain
 * 2026-11-03:
 *
 *   Asset Hub   DOT native (10 dp), USDT = Assets 1984, USDC = Assets 1337,
 *               dotUSD = Assets 7873 (the PSM's internal stablecoin; USDT is
 *               its only external asset). Every AssetConversion pool pairs
 *               DOT with one asset, so stable ⇄ stable routes through DOT.
 *   Hydration   AssetRegistry 5 = DOT, 10 = USDT (AH 1984), 22 = USDC
 *               (AH 1337), 0 = HDX (12 dp). dotUSD is NOT registered on
 *               Hydration, so PSM legs stay on Asset Hub.
 */

export type Sym = 'DOT' | 'USDT' | 'USDC';
export type Chain = 'AH' | 'HY';

export const SYMS: readonly Sym[] = ['DOT', 'USDT', 'USDC'];
export const CHAINS: readonly Chain[] = ['AH', 'HY'];
export const CHAIN_NAME: Record<Chain, string> = { AH: 'Asset Hub', HY: 'Hydration' };

/** An XCM v5 location as polkadot-api encodes it. */
export type Location = {
  parents: number;
  interior: { type: 'Here' } | { type: 'X1'; value: unknown } | { type: 'X2'; value: unknown[] } | { type: 'X3'; value: unknown[] };
};

const ahAsset = (index: number): Location => ({
  parents: 0,
  interior: {
    type: 'X2',
    value: [
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: BigInt(index) },
    ],
  },
});
const ahAssetFromSibling = (index: number): Location => ({
  parents: 1,
  interior: {
    type: 'X3',
    value: [
      { type: 'Parachain', value: 1000 },
      { type: 'PalletInstance', value: 50 },
      { type: 'GeneralIndex', value: BigInt(index) },
    ],
  },
});
export const DOT_LOCATION: Location = { parents: 1, interior: { type: 'Here' } };

export interface AssetInfo {
  sym: Sym;
  decimals: number;
  /** Asset Hub `Assets` index (undefined for native DOT). */
  ahIndex?: number;
  /** As Asset Hub sees it. */
  ahLocation: Location;
  /** Hydration AssetRegistry id. */
  hyId: number;
  /** As Hydration sees it. */
  hyLocation: Location;
}

export const ASSETS: Record<Sym, AssetInfo> = {
  DOT: { sym: 'DOT', decimals: 10, ahLocation: DOT_LOCATION, hyId: 5, hyLocation: DOT_LOCATION },
  USDT: { sym: 'USDT', decimals: 6, ahIndex: 1984, ahLocation: ahAsset(1984), hyId: 10, hyLocation: ahAssetFromSibling(1984) },
  USDC: { sym: 'USDC', decimals: 6, ahIndex: 1337, ahLocation: ahAsset(1337), hyId: 22, hyLocation: ahAssetFromSibling(1337) },
};

/**
 * Bridged ether (Snowbridge), watched but not traded: the bot quotes the
 * DOT/ETH round trip between the chains to show whether it would pay. On
 * Asset Hub it is a foreign asset with its own DOT/ETH pool (small, ~$4.6k on
 * 2026-11-04); on Hydration it is asset 34. Same location on both chains.
 */
export const ETH = {
  decimals: 18,
  location: {
    parents: 2,
    interior: { type: 'X1', value: { type: 'GlobalConsensus', value: { type: 'Ethereum', value: { chain_id: 1n } } } },
  } as Location,
  hyId: 34,
};

/** The PSM's internal stablecoin on Asset Hub. Never leaves Asset Hub. */
export const DOTUSD = { index: 7873, decimals: 6, location: ahAsset(7873) };
export const HDX = { id: 0, decimals: 12 };

export const ASSET_HUB_PARA = 1000;
export const HYDRATION_PARA = 2034;

/**
 * XCM multi-asset lists must be sorted by location (parents, then interior).
 * On Asset Hub the local assets (parents 0) sort before DOT; on Hydration DOT
 * (Here) sorts before the X3 stables. Within each, lower GeneralIndex first.
 */
export function xcmSortKey(chain: Chain, sym: Sym): number {
  const order: Record<Chain, Sym[]> = { AH: ['USDC', 'USDT', 'DOT'], HY: ['DOT', 'USDC', 'USDT'] };
  return order[chain].indexOf(sym);
}

/** Native units → human number (display / USD math only, never sent to a chain). */
export function human(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/** Human number → native units (floors). */
export function native(value: number, decimals: number): bigint {
  if (!Number.isFinite(value) || value <= 0) return 0n;
  return BigInt(Math.floor(value * 10 ** decimals));
}

export function fmt(amount: bigint, decimals: number, dp = 4): string {
  return human(amount, decimals).toFixed(dp);
}
