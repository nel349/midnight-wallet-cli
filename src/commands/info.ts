// info command — display wallet metadata (no secrets)
// Shows addresses for all networks + shielded, creation date, file path

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig, resolveWalletPath } from '../lib/wallet-config.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { header, divider } from '../ui/format.ts';
import { formatAddress } from '../ui/format.ts';
import { bold, dim, teal } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function infoCommand(args: ParsedArgs): Promise<void> {
  const resolvedPath = resolveWalletPath(getFlag(args, 'wallet'));
  const config = loadWalletConfig(resolvedPath);
  const activeNetwork = resolveNetworkName({ args });
  const activeAddress = config.addresses[activeNetwork];

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      addresses: config.addresses,
      activeNetwork,
      activeAddress,
      createdAt: config.createdAt,
      file: resolvedPath,
    };
    if (config.shieldedAddresses) result.shieldedAddresses = config.shieldedAddresses;
    writeJsonResult(result);
    return;
  }

  // Bare active address to stdout (pipeable)
  process.stdout.write(activeAddress + '\n');

  // Header
  process.stderr.write('\n' + header('Wallet Info') + '\n\n');

  // Per-network grouping — unshielded + shielded together
  const networks = Object.keys(config.addresses) as Array<keyof typeof config.addresses>;
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i] as string;
    const isActiveNet = network === activeNetwork;
    const unshielded = config.addresses[network as keyof typeof config.addresses];
    const shielded = config.shieldedAddresses?.[network as keyof typeof config.addresses];

    const label = isActiveNet ? bold(teal(network)) + dim('  (active)') : network;
    process.stderr.write(`  ${label}\n`);
    process.stderr.write(`    ${dim('unshielded')}  ${formatAddress(unshielded as string)}\n`);
    if (shielded) {
      process.stderr.write(`    ${dim('shielded  ')}  ${formatAddress(shielded)}\n`);
    } else {
      process.stderr.write(`    ${dim('shielded  ')}  ${dim('(unavailable)')}\n`);
    }
    if (i < networks.length - 1) process.stderr.write('\n');
  }

  // Footer
  process.stderr.write('\n' + divider() + '\n\n');
  process.stderr.write(`  ${dim('created')}  ${config.createdAt}\n`);
  process.stderr.write(`  ${dim('file   ')}  ${resolvedPath}\n\n`);
}
