// wallet command — manage named wallets
// Subcommands: generate, list, use, info, remove

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveUnshieldedAddress } from '../lib/derive-address.ts';
import { resolveNetworkName } from '../lib/resolve-network.ts';
import {
  saveWalletConfig,
  loadWalletConfig,
  setActiveWallet,
  listWallets,
  removeWallet,
  resolveWalletPath,
  getActiveWalletName,
  type WalletConfig,
} from '../lib/wallet-config.ts';
import { WALLETS_DIR_NAME, MIDNIGHT_DIR, DIR_MODE } from '../lib/constants.ts';
import { header, keyValue, divider, formatAddress } from '../ui/format.ts';
import { bold, yellow, dim, green, teal } from '../ui/colors.ts';
import { writeJsonResult } from '../lib/json-output.ts';

export default async function walletCommand(args: ParsedArgs): Promise<void> {
  const subcommand = args.subcommand;

  switch (subcommand) {
    case 'generate':
      return walletGenerate(args);
    case 'list':
    case 'ls':
      return walletList(args);
    case 'use':
      return walletUse(args);
    case 'info':
      return walletInfo(args);
    case 'remove':
    case 'rm':
      return walletRemove(args);
    default:
      throw new Error(
        `Unknown wallet subcommand: "${subcommand ?? '(none)'}"\n` +
        `Available: generate, list, use, info, remove\n` +
        `Run "midnight help wallet" for usage.`
      );
  }
}

async function walletGenerate(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet generate <name> [--network <name>]'
    );
  }

  if (/[\/\\]/.test(name) || name.endsWith('.json')) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators or .json extension).`
    );
  }

  const networkName = resolveNetworkName({ args });
  const seedHex = getFlag(args, 'seed');
  const mnemonicStr = getFlag(args, 'mnemonic');

  if (seedHex !== undefined && mnemonicStr !== undefined) {
    throw new Error('Cannot specify both --seed and --mnemonic. Use one or the other.');
  }

  // Resolve target path
  const walletsDir = path.join(homedir(), MIDNIGHT_DIR, WALLETS_DIR_NAME);
  const targetPath = path.join(walletsDir, `${name}.json`);

  if (fs.existsSync(targetPath) && !hasFlag(args, 'force')) {
    throw new Error(
      `Wallet "${name}" already exists: ${targetPath}\n` +
      `Use --force to overwrite.`
    );
  }

  let seedBuffer: Buffer;
  let mnemonic: string | undefined;

  if (seedHex !== undefined) {
    const cleaned = seedHex.replace(/^0x/, '');
    if (cleaned.length !== 64 || !/^[0-9a-fA-F]+$/.test(cleaned)) {
      throw new Error('Seed must be a 64-character hex string (32 bytes)');
    }
    seedBuffer = Buffer.from(cleaned, 'hex');
  } else if (mnemonicStr !== undefined) {
    if (!validateMnemonic(mnemonicStr, wordlist)) {
      throw new Error('Invalid BIP-39 mnemonic. Expected 12 or 24 words from the English wordlist.');
    }
    mnemonic = mnemonicStr;
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic).slice(0, 32));
  } else {
    mnemonic = generateMnemonic(wordlist, 256);
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

  const savedPath = saveWalletConfig(config, targetPath);

  // Set as active wallet
  setActiveWallet(name);

  // JSON mode
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      name,
      address,
      network: networkName,
      seed: seedBuffer.toString('hex'),
      file: savedPath,
      createdAt: config.createdAt,
      active: true,
    };
    if (mnemonic) result.mnemonic = mnemonic;
    writeJsonResult(result);
    return;
  }

  // Address to stdout (pipeable)
  process.stdout.write(address + '\n');

  // Details to stderr
  process.stderr.write('\n' + header('Wallet Generated') + '\n\n');
  process.stderr.write(keyValue('Name', name) + '\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(address)) + '\n');
  process.stderr.write(keyValue('File', savedPath) + '\n');
  process.stderr.write(keyValue('Active', 'yes') + '\n');
  process.stderr.write('\n');

  if (mnemonic) {
    process.stderr.write(yellow(bold('  MNEMONIC (save securely!):')) + '\n');
    process.stderr.write(`  ${mnemonic}\n\n`);
  }

  process.stderr.write(yellow(bold('  SEED (hex):')) + '\n');
  process.stderr.write(`  ${seedBuffer.toString('hex')}\n\n`);

  process.stderr.write(divider() + '\n');
  process.stderr.write(dim('  Next: midnight wallet list | midnight balance') + '\n\n');
  process.stderr.write(green('✓') + ' Wallet saved\n');
}

async function walletList(args: ParsedArgs): Promise<void> {
  const wallets = listWallets();

  if (hasFlag(args, 'json')) {
    writeJsonResult({ wallets });
    return;
  }

  if (wallets.length === 0) {
    process.stderr.write('\n  No wallets found.\n');
    process.stderr.write(dim('  Create one: midnight wallet generate <name> --network <name>') + '\n\n');
    return;
  }

  process.stderr.write('\n' + header('Wallets') + '\n\n');

  for (const w of wallets) {
    const marker = w.isActive ? green(' ●') : '  ';
    const paddedName = w.name.padEnd(16);
    const nameStr = w.isActive ? bold(teal(paddedName)) : teal(paddedName);
    const addrTrunc = w.address.length > 30
      ? w.address.slice(0, 20) + '...' + w.address.slice(-8)
      : w.address;
    process.stderr.write(`${marker} ${nameStr} ${addrTrunc.padEnd(35)} ${dim(w.network)}\n`);
  }

  process.stderr.write('\n' + divider() + '\n');
  process.stderr.write(dim('  ● = active wallet') + '\n\n');
}

async function walletUse(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet use <name>'
    );
  }

  setActiveWallet(name);

  if (hasFlag(args, 'json')) {
    writeJsonResult({ wallet: name, active: true });
    return;
  }

  process.stderr.write(green('✓') + ` Active wallet set to "${name}"\n`);
}

async function walletInfo(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0] ?? getActiveWalletName();
  const walletPath = resolveWalletPath(name);
  const config = loadWalletConfig(walletPath);
  const isActive = name === getActiveWalletName();

  if (hasFlag(args, 'json')) {
    writeJsonResult({
      name,
      address: config.address,
      network: config.network,
      createdAt: config.createdAt,
      file: walletPath,
      active: isActive,
    });
    return;
  }

  // Bare address to stdout (pipeable)
  process.stdout.write(config.address + '\n');

  process.stderr.write('\n' + header('Wallet Info') + '\n\n');
  process.stderr.write(keyValue('Name', name) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(config.address)) + '\n');
  process.stderr.write(keyValue('Network', config.network) + '\n');
  process.stderr.write(keyValue('Created', config.createdAt) + '\n');
  process.stderr.write(keyValue('File', walletPath) + '\n');
  process.stderr.write(keyValue('Active', isActive ? 'yes' : 'no') + '\n');
  process.stderr.write('\n' + divider() + '\n\n');
}

async function walletRemove(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0];
  if (!name) {
    throw new Error(
      'Missing wallet name.\nUsage: midnight wallet remove <name>'
    );
  }

  removeWallet(name);

  if (hasFlag(args, 'json')) {
    writeJsonResult({ wallet: name, removed: true });
    return;
  }

  process.stderr.write(green('✓') + ` Wallet "${name}" removed\n`);
}
