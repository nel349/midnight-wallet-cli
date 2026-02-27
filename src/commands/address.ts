// address command — derive and display an unshielded address from a seed
// Bare address to stdout (pipeable), formatted details to stderr

import { type ParsedArgs, requireFlag, getFlag } from '../lib/argv.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { keyValue, divider, formatAddress } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function addressCommand(args: ParsedArgs): Promise<void> {
  const seedHex = requireFlag(args, 'seed', 'hex').replace(/^0x/, '');

  if (seedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(seedHex)) {
    throw new Error('Seed must be a 64-character hex string (32 bytes)');
  }

  const indexStr = getFlag(args, 'index');
  const keyIndex = indexStr !== undefined ? parseInt(indexStr, 10) : 0;
  if (isNaN(keyIndex) || keyIndex < 0 || !Number.isInteger(Number(indexStr ?? '0'))) {
    throw new Error('Key index must be a non-negative integer');
  }

  const seedBuffer = Buffer.from(seedHex, 'hex');
  const networkName = resolveNetworkName({ args });
  const address = deriveUnshieldedAddress(seedBuffer, networkName, keyIndex);

  // Bare address to stdout (pipeable)
  process.stdout.write(address + '\n');

  // Formatted details to stderr
  process.stderr.write('\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Index', keyIndex.toString()) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
  process.stderr.write(keyValue('Path', dim(`m/44'/2400'/0'/NightExternal/${keyIndex}`)) + '\n');
  process.stderr.write(divider() + '\n\n');
}
