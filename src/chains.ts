/**
 * Connections, the key, balances and the one place a transaction is sent.
 *
 * Every transaction goes through `send`: it is dry-run on the chain first
 * (DryRunApi.dry_run_call — both runtimes have it) and only signed and
 * submitted when the dry run dispatches cleanly. It resolves once the
 * transaction is in a finalized block and throws if it failed there.
 */
import { WebSocket } from 'ws';
(globalThis as { WebSocket?: unknown }).WebSocket ??= WebSocket; // Node 20 has no global WebSocket

import { api as sdkApi, createSdkContext, type SdkCtx } from '@galacticcouncil/sdk-next';
import { sr25519CreateDerive } from '@polkadot-labs/hdkd';
import { entropyToMiniSecret, mnemonicToEntropy, ss58Address, validateMnemonic } from '@polkadot-labs/hdkd-helpers';
import { Binary, createClient, Enum, type PolkadotClient, type PolkadotSigner, type Transaction } from 'polkadot-api';
import { getPolkadotSigner } from 'polkadot-api/signer';
import { getWsProvider } from 'polkadot-api/ws';
import { ASSETS, DOTUSD, HDX, SYMS, type Chain, type Location, type Sym } from './assets.js';
import { log } from './log.js';

/* The Galactic SDK 2.0.0 leaks a debug console.log for every oracle event. */
const rawLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const first = args[0] as { eventName?: unknown } | undefined;
  if (first && typeof first === 'object' && typeof first.eventName === 'string' && /Oracle/.test(first.eventName)) return;
  rawLog(...args);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Unsafe = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = Transaction<any, any>;

export interface Wallet {
  signer: PolkadotSigner;
  publicKey: Uint8Array;
  /** 0x-hex account id (for XCM beneficiaries). */
  accountId: `0x${string}`;
  ah: string; // SS58 prefix 0
  hy: string; // SS58 prefix 63
}

export function walletFromMnemonic(mnemonic: string, derivation = ''): Wallet {
  const phrase = mnemonic.trim().split(/\s+/).join(' ');
  if (!validateMnemonic(phrase)) throw new Error('ARB_MNEMONIC is not a valid BIP-39 mnemonic');
  const keyPair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(phrase)))(derivation);
  return {
    signer: getPolkadotSigner(keyPair.publicKey, 'Sr25519', keyPair.sign),
    publicKey: keyPair.publicKey,
    accountId: Binary.toHex(keyPair.publicKey) as `0x${string}`,
    ah: ss58Address(keyPair.publicKey, 0),
    hy: ss58Address(keyPair.publicKey, 63),
  };
}

export interface Chains {
  ahClient: PolkadotClient;
  hyClient: PolkadotClient;
  ah: Unsafe;
  hy: Unsafe;
  sdk: SdkCtx;
  destroy(): void;
}

export async function connect(ahRpc: string, hyRpc: string): Promise<Chains> {
  const ahClient = createClient(getWsProvider(ahRpc));
  const hyClient = createClient(sdkApi.getWs(hyRpc));
  const timeout = <T>(p: Promise<T>, what: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in 60s`)), 60_000).unref())]);
  const [, sdk] = await Promise.all([
    timeout(ahClient.getFinalizedBlock(), `Asset Hub (${ahRpc})`),
    timeout(createSdkContext(hyClient), `Hydration (${hyRpc})`),
  ]);
  return {
    ahClient,
    hyClient,
    ah: ahClient.getUnsafeApi(),
    hy: hyClient.getUnsafeApi(),
    sdk,
    destroy() {
      sdk.destroy();
      ahClient.destroy();
      hyClient.destroy();
    },
  };
}

/* ------------------------------------------------------------------ balances */

/** Spendable balances per chain, native units. `dotUSD` only exists on AH, `HDX` only on HY. */
export type Book = Record<Chain, Record<Sym | 'dotUSD' | 'HDX', bigint>>;

export async function readBook(c: Chains, w: Wallet): Promise<Book> {
  const ahAsset = (index: number) =>
    c.ah.query.Assets.Account.getValue(index, w.ah).then((a: { balance: bigint } | undefined) => a?.balance ?? 0n);
  const hyToken = (id: number) =>
    c.hy.query.Tokens.Accounts.getValue(w.hy, id).then((a: { free: bigint; frozen: bigint }) => a.free - a.frozen);
  const [ahSys, ahUsdt, ahUsdc, ahDotUsd, hySys, hyDot, hyUsdt, hyUsdc] = await Promise.all([
    c.ah.query.System.Account.getValue(w.ah),
    ahAsset(ASSETS.USDT.ahIndex!),
    ahAsset(ASSETS.USDC.ahIndex!),
    ahAsset(DOTUSD.index),
    c.hy.query.System.Account.getValue(w.hy),
    hyToken(ASSETS.DOT.hyId),
    hyToken(ASSETS.USDT.hyId),
    hyToken(ASSETS.USDC.hyId),
  ]);
  const free = (s: { data: { free: bigint; frozen: bigint } }) => (s.data.free > s.data.frozen ? s.data.free - s.data.frozen : 0n);
  return {
    AH: { DOT: free(ahSys), USDT: ahUsdt, USDC: ahUsdc, dotUSD: ahDotUsd, HDX: 0n },
    HY: { DOT: hyDot, USDT: hyUsdt, USDC: hyUsdc, dotUSD: 0n, HDX: free(hySys) },
  };
}

/** USD prices used to value the book: DOT from the AH DOT/USDT pool, stables at $1, HDX from Hydration's router. */
export interface Prices {
  DOT: number;
  USDT: number;
  USDC: number;
  dotUSD: number;
  HDX: number;
}

export async function readPrices(c: Chains): Promise<Prices> {
  const [reserves, hdx] = await Promise.all([
    c.ah.apis.AssetConversionApi.get_reserves(ASSETS.DOT.ahLocation, ASSETS.USDT.ahLocation) as Promise<[bigint, bigint] | undefined>,
    c.sdk.api.router.getSpotPrice(HDX.id, ASSETS.USDT.hyId).catch(() => undefined),
  ]);
  if (!reserves) throw new Error('Asset Hub DOT/USDT pool has no reserves');
  const dot = Number(reserves[1]) / 1e6 / (Number(reserves[0]) / 1e10);
  const hdxUsd = hdx && hdx.amount > 0n ? Number(hdx.amount) / 10 ** hdx.decimals : 0;
  return { DOT: dot, USDT: 1, USDC: 1, dotUSD: 1, HDX: hdxUsd };
}

const DECIMALS: Record<keyof Prices, number> = { DOT: 10, USDT: 6, USDC: 6, dotUSD: DOTUSD.decimals, HDX: HDX.decimals };

export function usdOf(book: Book, p: Prices, chain?: Chain): number {
  let total = 0;
  for (const ch of chain ? [chain] : (['AH', 'HY'] as Chain[])) {
    for (const k of Object.keys(DECIMALS) as (keyof Prices)[]) total += (Number(book[ch][k]) / 10 ** DECIMALS[k]) * p[k];
  }
  return total;
}

/** Book delta valued at fixed prices: what an action earned or cost, fees included, market moves excluded. */
export function deltaUsd(before: Book, after: Book, p: Prices): number {
  return usdOf(after, p) - usdOf(before, p);
}

export function symUsd(sym: Sym, amount: bigint, p: Prices): number {
  return (Number(amount) / 10 ** ASSETS[sym].decimals) * p[sym];
}

export { SYMS };

/* --------------------------------------------------------------- submission */

export interface Sent {
  chain: Chain;
  label: string;
  hash: string;
  block: number;
}

/** "Pallet.Error" from a dispatch error, as far as it can be read. */
export function errorText(e: unknown): string {
  const err = e as { type?: string; value?: { type?: string; value?: { type?: string } } } | undefined;
  if (!err || typeof err !== 'object') return String(e);
  if (err.type === 'Module' && err.value?.type) return `${err.value.type}.${err.value.value?.type ?? '?'}`;
  if (err.type === 'Token' || err.type === 'Arithmetic') return `${err.type}.${err.value?.type ?? '?'}`;
  return err.type ?? JSON.stringify(err, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** DryRunApi.dry_run_call; throws with the dispatch error when the call would fail. */
export async function dryRun(api: Unsafe, address: string, tx: Tx): Promise<{ events: Array<{ type: string; value: { type: string; value: unknown } }> }> {
  const res = await api.apis.DryRunApi.dry_run_call(Enum('system', Enum('Signed', address)), tx.decodedCall, 5);
  if (!res.success) throw new Error(`dry run could not run (${res.value?.type ?? 'unknown'})`);
  if (!res.value.execution_result.success) throw new Error(`dry run failed: ${errorText(res.value.execution_result.value.error)}`);
  return { events: res.value.emitted_events };
}

export interface SendOpts {
  /** Pay the Asset Hub fee in this asset (used until the account holds DOT). */
  feeAsset?: Location;
  /** The caller already dry-ran it (two legs dry-run together, then submitted together). */
  dryRunDone?: boolean;
}

export async function send(c: Chains, w: Wallet, chain: Chain, label: string, tx: Tx, opts: SendOpts = {}): Promise<Sent> {
  const api = chain === 'AH' ? c.ah : c.hy;
  const address = chain === 'AH' ? w.ah : w.hy;
  if (!opts.dryRunDone) await dryRun(api, address, tx);
  log.tx(chain, `${label} … signing`);
  const res = await tx.signAndSubmit(w.signer, opts.feeAsset ? ({ asset: opts.feeAsset } as never) : undefined);
  if (!res.ok) throw new Error(`${label} failed in block ${res.block.number}: ${errorText(res.dispatchError)}`);
  log.tx(chain, `${label} ✓ block ${res.block.number} ${res.txHash}`);
  return { chain, label, hash: res.txHash, block: res.block.number };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
