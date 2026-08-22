// address command — derive and display an unshielded address from a seed
// Bare address to stdout (pipeable), formatted details to stderr

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { UsageError } from '../lib/errors.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { keyValue, divider, formatAddress } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

// Resolve the seed for `address`. Precedence: --seed flag > MN_SEED env > named wallet.
// MN_SEED keeps the seed off argv, where `ps` would leak it to every user on the box —
// env vars are only readable by the same user. Mirrors `dust export`'s resolver.
function resolveAddressSeed(args: ParsedArgs): Buffer {
  const seedFlag = getFlag(args, 'seed');
  const seedSource = seedFlag ?? process.env.MN_SEED;
  if (seedSource) {
    // trim first — a seed sourced from a file / command substitution (common with
    // MN_SEED=$(cat seed.hex)) carries a trailing newline that would fail the length check.
    const seedHex = seedSource.trim().replace(/^0x/, '');
    if (seedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(seedHex)) {
      throw new UsageError(`${seedFlag ? '--seed' : 'MN_SEED'} must be a 64-character hex string (32 bytes)`);
    }
    return Buffer.from(seedHex, 'hex');
  }

  const walletName = getFlag(args, 'wallet');
  if (walletName !== undefined) {
    return Buffer.from(loadWalletConfig(resolveWalletPath(walletName)).seed, 'hex');
  }

  throw new UsageError(
    'address needs a seed source. Provide one of:\n' +
    '  --seed <hex>     32-byte seed as 64 hex characters\n' +
    '  MN_SEED=<hex>    same seed via env (kept off the process list)\n' +
    '  --wallet <name>  derive from a saved wallet'
  );
}

export default async function addressCommand(args: ParsedArgs): Promise<void> {
  const seedBuffer = resolveAddressSeed(args);

  const indexStr = getFlag(args, 'index');
  const keyIndex = indexStr !== undefined ? parseInt(indexStr, 10) : 0;
  if (isNaN(keyIndex) || keyIndex < 0 || !Number.isInteger(Number(indexStr ?? '0'))) {
    throw new Error('Key index must be a non-negative integer');
  }

  const networkName = resolveNetworkName({ args });
  const address = deriveUnshieldedAddress(seedBuffer, networkName, keyIndex);
  const derivationPath = `m/44'/2400'/0'/NightExternal/${keyIndex}`;

  // JSON mode
  if (hasFlag(args, 'json')) {
    writeJsonResult({
      address,
      network: networkName,
      index: keyIndex,
      path: derivationPath,
    });
    return;
  }

  // Bare address to stdout (pipeable)
  process.stdout.write(address + '\n');

  // Formatted details to stderr
  process.stderr.write('\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Index', keyIndex.toString()) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
  process.stderr.write(keyValue('Path', dim(derivationPath)) + '\n');
  process.stderr.write(divider() + '\n\n');
}
