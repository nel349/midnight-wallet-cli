// A wallet file as mn wrote it before the keystore: the seed and mnemonic in
// plain text beside the addresses. mn still reads such files (with a warning)
// until `midnight wallet protect` seals them, so the tests that need a wallet
// fixture write one this way; mn itself never writes a plain-text wallet.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { DIR_MODE, FILE_MODE } from '../../lib/constants.ts';
import type { NetworkName } from '../../lib/network.ts';

export interface PlainWalletConfig {
  seed: string;
  mnemonic?: string;
  addresses: Record<NetworkName, string>;
  shieldedAddresses?: Record<NetworkName, string>;
  createdAt: string;
}

/** Writes `config` to `walletPath` in plain text, as an earlier mn did. */
export function saveWalletConfig(config: PlainWalletConfig, walletPath: string): string {
  const resolvedPath = path.resolve(walletPath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: DIR_MODE });
  fs.writeFileSync(resolvedPath, JSON.stringify(config, null, 2) + '\n', { mode: FILE_MODE });
  return resolvedPath;
}
