// info command — display wallet metadata (no secrets)
// Shows addresses for all networks, creation date, file path

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { header, keyValue, divider } from '../ui/format.ts';
import { formatAddress } from '../ui/format.ts';
import { bold, dim } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function infoCommand(args: ParsedArgs): Promise<void> {
  const resolvedPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(resolvedPath);
  const activeNetwork = resolveNetworkName({ args });
  const activeAddress = config.addresses[activeNetwork];

  // JSON mode
  if (hasFlag(args, 'json')) {
    writeJsonResult({
      addresses: config.addresses,
      activeNetwork,
      activeAddress,
      createdAt: config.createdAt,
      file: resolvedPath,
    });
    return;
  }

  // Bare active address to stdout (pipeable)
  process.stdout.write(activeAddress + '\n');

  // Formatted details to stderr
  process.stderr.write('\n' + header('Wallet Info') + '\n\n');

  // Show all addresses, highlighting active network
  for (const [network, addr] of Object.entries(config.addresses)) {
    const isActive = network === activeNetwork;
    const label = isActive ? bold(network) : network;
    const marker = isActive ? ' *' : '';
    process.stderr.write(keyValue(label + marker, formatAddress(addr)) + '\n');
  }

  process.stderr.write('\n');
  process.stderr.write(keyValue('Active Network', activeNetwork) + '\n');
  process.stderr.write(keyValue('Created', config.createdAt) + '\n');
  process.stderr.write(keyValue('File', resolvedPath) + '\n');
  process.stderr.write(dim('  * = active network') + '\n');
  process.stderr.write('\n' + divider() + '\n\n');
}
