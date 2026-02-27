// genesis-address command — display the genesis wallet address (seed 0x01)

import { type ParsedArgs } from '../lib/argv.ts';
import { GENESIS_SEED } from '../lib/constants.ts';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { keyValue, divider, formatAddress } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function genesisAddressCommand(args: ParsedArgs): Promise<void> {
  const networkName = resolveNetworkName({ args });
  const seedBuffer = Buffer.from(GENESIS_SEED, 'hex');
  const address = deriveUnshieldedAddress(seedBuffer, networkName);

  // Bare address to stdout (pipeable)
  process.stdout.write(address + '\n');

  // Details to stderr
  process.stderr.write('\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
  process.stderr.write(keyValue('Seed', dim('0x01 (genesis)')) + '\n');
  process.stderr.write(divider() + '\n\n');
}
