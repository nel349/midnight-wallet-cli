// cache command — manage wallet state cache
// cache clear [--network <name>] [--wallet <name|file>]

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { clearWalletCache } from '../lib/wallet-cache.ts';
import { clearDustDirectCache, dustPublicKeyHexFromSeed } from '../lib/dust-direct-cache.ts';
import { resolveWalletPath, loadWalletConfig } from '../lib/wallet-config.ts';
import { resolveNetwork } from '../lib/resolve-network.ts';
import { green } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function cacheCommand(args: ParsedArgs): Promise<void> {
  const action = args.subcommand;

  if (action !== 'clear') {
    throw new UsageError(
      `Usage: midnight cache clear [--network <name>] [--wallet <name|file>]`
    );
  }

  const walletFlag = getFlag(args, 'wallet');
  const networkFlag = getFlag(args, 'network');
  const jsonMode = hasFlag(args, 'json');

  if (walletFlag) {
    // Clear cache for a specific wallet
    const walletPath = resolveWalletPath(walletFlag);
    const config = loadWalletConfig(walletPath);
    const { name: networkName } = resolveNetwork({ args });
    const address = config.addresses[networkName];
    clearWalletCache(address, networkName);
    // Also clear the dust-direct cache for this wallet on this network.
    const dustPubkey = dustPublicKeyHexFromSeed(Buffer.from(config.seed, 'hex'));
    clearDustDirectCache(networkName, dustPubkey);
    if (jsonMode) {
      writeJsonResult({ action: 'clear', scope: 'wallet', wallet: walletFlag, network: networkName });
      return;
    }
    process.stderr.write(green('✓') + ` Cache cleared for wallet "${walletFlag}" on ${networkName}\n`);
  } else if (networkFlag) {
    // Clear cache for a specific network
    clearWalletCache(undefined, networkFlag);
    clearDustDirectCache(networkFlag);
    if (jsonMode) {
      writeJsonResult({ action: 'clear', scope: 'network', network: networkFlag });
      return;
    }
    process.stderr.write(green('✓') + ` Cache cleared for network "${networkFlag}"\n`);
  } else {
    // Clear all cache
    clearWalletCache();
    clearDustDirectCache();
    if (jsonMode) {
      writeJsonResult({ action: 'clear', scope: 'all' });
      return;
    }
    process.stderr.write(green('✓') + ' Cache cleared\n');
  }
}
