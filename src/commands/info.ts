// info command — display wallet metadata (no secrets)
// Shows address, network, creation date, file path

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { loadWalletConfig } from '../lib/wallet-config.ts';
import { header, keyValue, divider } from '../ui/format.ts';
import { formatAddress } from '../ui/format.ts';
import * as path from 'path';
import { homedir } from 'os';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME } from '../lib/constants.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function infoCommand(args: ParsedArgs): Promise<void> {
  const walletPath = getFlag(args, 'wallet');
  const config = loadWalletConfig(walletPath);

  const resolvedPath = walletPath
    ? path.resolve(walletPath)
    : path.join(homedir(), MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME);

  // JSON mode
  if (hasFlag(args, 'json')) {
    writeJsonResult({
      address: config.address,
      network: config.network,
      createdAt: config.createdAt,
      file: resolvedPath,
    });
    return;
  }

  // Bare address to stdout (pipeable)
  process.stdout.write(config.address + '\n');

  // Formatted details to stderr
  process.stderr.write('\n' + header('Wallet Info') + '\n\n');
  process.stderr.write(keyValue('Address', formatAddress(config.address)) + '\n');
  process.stderr.write(keyValue('Network', config.network) + '\n');
  process.stderr.write(keyValue('Created', config.createdAt) + '\n');
  process.stderr.write(keyValue('File', resolvedPath) + '\n');
  process.stderr.write('\n' + divider() + '\n\n');
}
