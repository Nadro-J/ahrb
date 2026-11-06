/**
 * Read-only check that the bot's XCM transfers work end to end for an asset:
 *
 *   npm run verify-xcm -- ETH
 *
 * For each direction (Asset Hub → Hydration and back), both on its own and
 * paired with DOT (as the bot sends them):
 *   1. the source chain dry-runs the exact transaction `xcmTransfer` builds
 *      (DryRunApi.dry_run_call),
 *   2. the destination dry-runs the message the source would forward
 *      (DryRunApi.dry_run_xcm) and must deposit the asset to the beneficiary.
 *
 * A dry run needs no key, so the sender is an account that already holds the
 * asset (found on chain, or ARB_VERIFY_AH_HOLDER / ARB_VERIFY_HY_HOLDER).
 * Nothing is signed or sent.
 */
import { ss58Address, ss58Decode } from '@polkadot-labs/hdkd-helpers';
import { Binary, Enum } from 'polkadot-api';
import { ASSET_HUB_PARA, ASSETS, HYDRATION_PARA, SYMS, type Chain, type Sym } from './assets.js';
import { BEST, connect, type Chains, type Wallet } from './chains.js';
import { c as color, log } from './log.js';
import { xcmMessages, xcmTransfer, type XcmItem } from './venues.js';

const sym = (process.argv[2] ?? 'ETH').toUpperCase() as Sym;
if (!SYMS.includes(sym)) throw new Error(`unknown asset ${sym}; one of ${SYMS.join(', ')}`);
const usd = Number(process.argv[3] ?? 5);

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x instanceof Uint8Array ? Binary.toHex(x) : x));

function walletFor(address: string): Wallet {
  const [publicKey] = ss58Decode(address);
  return {
    signer: null as never, // never signs
    publicKey,
    accountId: Binary.toHex(publicKey) as `0x${string}`,
    ah: ss58Address(publicKey, 0),
    hy: ss58Address(publicKey, 63),
  };
}

/** Hydration's Omnipool account: PalletId(*b"omnipool") as an account. */
function omnipoolAccount(): string {
  const id = new Uint8Array(32);
  id.set(new TextEncoder().encode('modlomnipool'));
  return ss58Address(id, 63);
}

/** An Asset Hub account holding at least `min` of the asset and 1 DOT for fees. */
async function ahHolder(c: Chains, min: bigint): Promise<string | null> {
  if (process.env.ARB_VERIFY_AH_HOLDER) return process.env.ARB_VERIFY_AH_HOLDER;
  const a = ASSETS[sym];
  if (sym === 'DOT') return null; // pass ARB_VERIFY_AH_HOLDER
  const entries: { keyArgs: [unknown, string]; value: { balance: bigint } }[] =
    a.ahIndex === undefined
      ? await c.ah.query.ForeignAssets.Account.getEntries(a.ahLocation, BEST)
      : await c.ah.query.Assets.Account.getEntries(a.ahIndex, BEST);
  const rich = entries.filter((e) => e.value.balance >= min).sort((x, y) => (y.value.balance > x.value.balance ? 1 : -1));
  for (const e of rich.slice(0, 20)) {
    const acct = await c.ah.query.System.Account.getValue(e.keyArgs[1], BEST);
    if (acct.data.free >= 10n ** 10n) return e.keyArgs[1];
  }
  return null;
}

/** The Hydration account of an EVM contract: b"ETH\0" ++ h160 ++ 8 zero bytes. */
function evmAccount(h160: string): string {
  const id = new Uint8Array(32);
  id.set(new TextEncoder().encode('ETH\0'));
  id.set(Binary.fromHex(h160) as unknown as Uint8Array, 4);
  return ss58Address(id, 63);
}

/**
 * A Hydration account holding at least `min`: the Omnipool, else the Aave
 * aToken contract that holds the asset (Hydration routes ETH through its Aave
 * money market, so the Omnipool holds none).
 */
async function hyHolder(c: Chains, min: bigint): Promise<string | null> {
  if (process.env.ARB_VERIFY_HY_HOLDER) return process.env.ARB_VERIFY_HY_HOLDER;
  const id = ASSETS[sym].hyId;
  const has = async (who: string) => (await c.hy.query.Tokens.Accounts.getValue(who, id, BEST)).free >= min;
  if (await has(omnipoolAccount())) return omnipoolAccount();
  const trade = await c.sdk.api.router.getBestSell(ASSETS.DOT.hyId, id, 10n ** 10n).catch(() => undefined);
  for (const swap of (trade?.swaps ?? []) as { assetOut: number; assetIn: number }[]) {
    for (const aToken of [swap.assetIn, swap.assetOut]) {
      const loc = json(await c.hy.query.AssetRegistry.AssetLocations.getValue(aToken, BEST)) ?? '';
      const h160 = loc.match(/0x[0-9a-f]{40}/)?.[0];
      if (h160 && (await has(evmAccount(h160)))) return evmAccount(h160);
    }
  }
  return null;
}

async function check(c: Chains, from: Chain, w: Wallet, items: XcmItem[]): Promise<boolean> {
  const src = from === 'AH' ? c.ah : c.hy;
  const dst = from === 'AH' ? c.hy : c.ah;
  const srcPara = from === 'AH' ? ASSET_HUB_PARA : HYDRATION_PARA;
  const destPara = from === 'AH' ? HYDRATION_PARA : ASSET_HUB_PARA;
  const what = `${from}→${from === 'AH' ? 'HY' : 'AH'} ${items.map((i) => i.sym).join(' + ')}`;
  const tx = xcmTransfer(c, w, from, items);
  const origin = from === 'AH' ? w.ah : w.hy;
  const res = await src.apis.DryRunApi.dry_run_call(Enum('system', Enum('Signed', origin)), tx.decodedCall, 5, BEST);
  if (!res.success || !res.value.execution_result.success) {
    log.error(`${what}: source dry run failed: ${json(res.success ? res.value.execution_result.value : res.value).slice(0, 300)}`);
    return false;
  }
  const fwd = (res.value.forwarded_xcms as [{ value: { interior: { value: unknown } } }, unknown[]][]).find(([loc]) =>
    json(loc).includes(`"value":${destPara}`)
  );
  if (!fwd || !fwd[1].length) {
    log.error(`${what}: the source forwards no message to para ${destPara}`);
    return false;
  }
  const originLoc = { type: 'V5', value: { parents: 1, interior: { type: 'X1', value: { type: 'Parachain', value: srcPara } } } };
  const out = await dst.apis.DryRunApi.dry_run_xcm(originLoc, fwd[1][0], BEST);
  if (!out.success) {
    log.error(`${what}: destination dry run could not run: ${json(out.value)}`);
    return false;
  }
  const result = out.value.execution_result;
  const events = (out.value.emitted_events as { type: string; value: { type: string; value: unknown } }[]).map((e) => `${e.type}.${e.value.type}`);
  const deposited = (out.value.emitted_events as { value: { value: unknown } }[]).some((e) => {
    const s = json(e.value.value);
    // The unsafe API prints accounts with either chain's SS58 prefix, or as hex.
    return s !== undefined && [w.accountId, w.ah, w.hy].some((a) => s.includes(a));
  });
  const ok = result.type === 'Complete' && deposited;
  (ok ? log.ok : log.error)(
    `${what}: source ok · destination ${result.type}${deposited ? ', deposited to the beneficiary' : ', NO deposit to the beneficiary'}` +
      color.dim(` (${[...new Set(events)].join(', ')})`)
  );
  if (!ok || process.env.ARB_VERIFY_DEBUG) {
    log.raw(color.dim(`  ${json(result).slice(0, 400)}`));
    for (const e of out.value.emitted_events as { type: string; value: { type: string } }[]) {
      if (/Deposit|Issued|Minted|Endowed/.test(e.value.type)) log.raw(color.dim(`  ${e.type}.${e.value.type} ${json(e.value).slice(0, 300)}`));
    }
  }
  return ok;
}

async function main(): Promise<void> {
  const c = await connect(
    process.env.ARB_ASSETHUB_RPC ?? 'wss://polkadot-asset-hub-rpc.polkadot.io',
    process.env.ARB_HYDRATION_RPC ?? 'wss://hydration-rpc.n.dwellir.com'
  );
  try {
    const { readPrices } = await import('./chains.js');
    const p = await readPrices(c);
    const amount = (s: Sym, dollars: number) => BigInt(Math.floor((dollars / p[s]) * 10 ** ASSETS[s].decimals));
    const item = { sym, amount: amount(sym, usd) };
    const dot = { sym: 'DOT' as Sym, amount: amount('DOT', 1) };
    log.step(`verifying XCM for ${sym}: ${usd} USD = ${item.amount} units, read-only dry runs`);

    let pass = true;
    for (const from of ['AH', 'HY'] as Chain[]) {
      const holder = from === 'AH' ? await ahHolder(c, item.amount * 2n) : await hyHolder(c, item.amount * 2n);
      if (!holder) {
        log.error(`no ${from} account found holding enough ${sym}; set ARB_VERIFY_${from}_HOLDER`);
        pass = false;
        continue;
      }
      log.info(color.dim(`${from} sender (dry run only): ${holder}`));
      const w = walletFor(holder);
      // Every message shape the bot can send with this asset in it: alone, and grouped with DOT as xcmMessages groups it.
      const shapes = [[item], ...xcmMessages([dot, item]).filter((m) => m.length > 1 && m.some((i) => i.sym === sym))];
      for (const shape of shapes) pass = (await check(c, from, w, shape)) && pass;
    }
    if (pass) log.ok(`${sym}: every XCM path verified`);
    else {
      log.error(`${sym}: some XCM paths failed — do not trade it until they pass`);
      process.exitCode = 1;
    }
  } finally {
    c.destroy();
  }
}

main().catch((e) => {
  log.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
