// generate command — create a new wallet
// Three modes: random mnemonic (default), --seed <hex>, --mnemonic "..."
// Saves wallet config to ~/.midnight/wallet.json (or --output <file>)

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import { saveWalletConfig, type WalletConfig } from '../lib/wallet-config.ts';
import { MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME } from '../lib/constants.ts';
import { header, keyValue, divider, formatAddress } from '../ui/format.ts';
import { bold, yellow, dim, green } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function generateCommand(args: ParsedArgs): Promise<void> {
  const networkName = resolveNetworkName({ args });
  const outputPath = getFlag(args, 'output');

  // Mutual exclusion: --seed and --mnemonic cannot both be specified
  const seedHex = getFlag(args, 'seed');
  const mnemonicStr = getFlag(args, 'mnemonic');

  if (seedHex !== undefined && mnemonicStr !== undefined) {
    throw new Error('Cannot specify both --seed and --mnemonic. Use one or the other.');
  }

  // Overwrite protection: check if target file already exists
  const targetPath = outputPath
    ? path.resolve(outputPath)
    : path.join(homedir(), MIDNIGHT_DIR, DEFAULT_WALLET_FILENAME);

  if (fs.existsSync(targetPath) && !hasFlag(args, 'force')) {
    throw new Error(
      `Wallet file already exists: ${targetPath}\n` +
      `Use --force to overwrite, or --output <file> to save to a different path.`
    );
  }

  let seedBuffer: Buffer;
  let mnemonic: string | undefined;

  if (seedHex !== undefined) {
    // Mode: restore from seed
    const cleaned = seedHex.replace(/^0x/, '');
    if (cleaned.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
      throw new Error('Seed must be a 64-character hex string (32 bytes)');
    }
    seedBuffer = Buffer.from(cleaned, 'hex');
  } else if (mnemonicStr !== undefined) {
    // Mode: restore from mnemonic
    if (!validateMnemonic(mnemonicStr, wordlist)) {
      throw new Error('Invalid BIP-39 mnemonic. Expected 12 or 24 words from the English wordlist.');
    }
    mnemonic = mnemonicStr;
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic).slice(0, 32));
  } else {
    // Mode: random (default)
    mnemonic = generateMnemonic(wordlist, 256); // 24 words
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic).slice(0, 32));
  }

  const address = deriveUnshieldedAddress(seedBuffer, networkName);

  const config: WalletConfig = {
    seed: seedBuffer.toString('hex'),
    network: networkName,
    address,
    createdAt: new Date().toISOString(),
  };

  if (mnemonic) {
    config.mnemonic = mnemonic;
  }

  const savedPath = saveWalletConfig(config, outputPath);

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      address,
      network: networkName,
      seed: seedBuffer.toString('hex'),
      file: savedPath,
      createdAt: config.createdAt,
    };
    if (mnemonic) result.mnemonic = mnemonic;
    writeJsonResult(result);
    return;
  }

  // Address to stdout (pipeable)
  process.stdout.write(address + '\n');

  // Details to stderr
  process.stderr.write('\n' + header('Wallet Generated') + '\n\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
  process.stderr.write(keyValue('File', savedPath) + '\n');
  process.stderr.write('\n');

  if (mnemonic) {
    process.stderr.write(yellow(bold('  MNEMONIC (save securely!):')) + '\n');
    process.stderr.write(`  ${mnemonic}\n\n`);
  }

  process.stderr.write(yellow(bold('  SEED (hex):')) + '\n');
  process.stderr.write(`  ${seedBuffer.toString('hex')}\n\n`);

  process.stderr.write(divider() + '\n');
  process.stderr.write(dim('  Next: midnight info | midnight balance') + '\n\n');
  process.stderr.write(green('✓') + ' Wallet saved\n');
}
