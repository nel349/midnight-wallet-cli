import { defaultRepository } from './src/lib/wallet-data-repository.ts';
import { resolveNetworkConfig } from './src/lib/network.ts';
import { loadWalletConfig, resolveWalletPath } from './src/lib/wallet-config.ts';

const walletPath = resolveWalletPath();
const cfg = loadWalletConfig(walletPath);
const networkConfig = resolveNetworkConfig('undeployed');
const seedBuffer = Buffer.from(cfg.seed, 'hex');

const result = await defaultRepository().withFacade(
  seedBuffer,
  networkConfig,
  async ({ state }: any) => {
    const toHex = (v: any): string => {
      if (typeof v === 'string') return v;
      if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
      if (Buffer.isBuffer(v)) return v.toString('hex');
      return String(v);
    };
    const coins = state.shielded.availableCoins.map((entry: any) => {
      const c = entry.coin;
      return {
        nonceType: typeof c.nonce,
        nonce: toHex(c.nonce),
        type: toHex(c.type),
        value: c.value.toString(),
        mt_index: c.mt_index?.toString() ?? null,
        commitment: entry.commitment ? toHex(entry.commitment) : null,
        nullifier: entry.nullifier ? toHex(entry.nullifier) : null,
        rawCoinKeys: Object.keys(c),
      };
    });
    return {
      balances: Object.fromEntries(
        Object.entries(state.shielded.balances).map(([k, v]: any) => [k, v.toString()]),
      ),
      coins,
      pendingCoinCount: state.shielded.pendingCoins.length,
    };
  },
  { syncMode: 'no-dust', readOnly: true, requireStrictSync: false },
);

console.log(JSON.stringify(result, null, 2));
