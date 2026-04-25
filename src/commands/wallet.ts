// wallet command — manage named wallets
// Subcommands: generate, list, use, info, remove

import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { generateMnemonic, mnemonicToSeedSync, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { deriveAllAddresses, deriveAllShieldedAddresses } from '../lib/derive-address.ts';
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
import { WALLETS_DIR_NAME, MIDNIGHT_DIR, isValidWalletName } from '../lib/constants.ts';
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
    case 'seed':
      return walletSeed(args);
    default:
      throw new Error(
        `Unknown wallet subcommand: "${subcommand ?? '(none)'}"\n` +
        `Available: generate, list, use, info, remove, seed\n` +
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

  if (!isValidWalletName(name)) {
    throw new Error(
      `Invalid wallet name: "${name}"\nWallet name must be a simple name (no path separators, .json suffix, or special characters).`
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
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic));
  } else {
    mnemonic = generateMnemonic(wordlist, 256);
    seedBuffer = Buffer.from(mnemonicToSeedSync(mnemonic));
  }

  const addresses = deriveAllAddresses(seedBuffer);
  const shieldedAddresses = deriveAllShieldedAddresses(seedBuffer);
  const activeAddress = addresses[networkName];

  const config: WalletConfig = {
    seed: seedBuffer.toString('hex'),
    addresses,
    shieldedAddresses,
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
      addresses,
      shieldedAddresses,
      activeAddress,
      activeNetwork: networkName,
      seed: seedBuffer.toString('hex'),
      file: savedPath,
      createdAt: config.createdAt,
      active: true,
    };
    if (mnemonic) result.mnemonic = mnemonic;
    writeJsonResult(result);
    return;
  }

  // Active address to stdout (pipeable)
  process.stdout.write(activeAddress + '\n');

  // Details to stderr
  process.stderr.write('\n' + header('Wallet Generated') + '\n\n');
  process.stderr.write(keyValue('Name', name) + '\n');
  process.stderr.write(keyValue('Network', networkName) + '\n');
  process.stderr.write(keyValue('Address', formatAddress(activeAddress)) + '\n');
  const activeShielded = shieldedAddresses[networkName];
  if (activeShielded) {
    process.stderr.write(keyValue('Shielded', formatAddress(activeShielded)) + '\n');
  }
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
  const networkName = resolveNetworkName({ args });

  if (hasFlag(args, 'json')) {
    // Agent-slim shape: per-wallet { name, active, network, address,
    // shieldedAddress } scoped to the active network. Triggered by
    // captureCommand injecting _minimal:true for all MCP calls. The MCP
    // tool surfaces a `full: true` escape hatch by also setting _full,
    // which forces the human shape.
    const minimal = hasFlag(args, '_minimal') && !hasFlag(args, '_full');
    if (minimal) {
      writeJsonResult({
        activeNetwork: networkName,
        wallets: wallets.map((w) => ({
          name: w.name,
          active: w.isActive,
          network: networkName,
          address: w.addresses[networkName] ?? null,
          shieldedAddress: w.shieldedAddresses?.[networkName] ?? null,
        })),
      });
      return;
    }
    writeJsonResult({
      activeNetwork: networkName,
      wallets: wallets.map((w) => ({
        name: w.name,
        active: w.isActive,
        addresses: w.addresses,
        shieldedAddresses: w.shieldedAddresses,
        createdAt: w.createdAt,
        file: w.file,
      })),
    });
    return;
  }

  if (wallets.length === 0) {
    process.stderr.write('\n  No wallets found.\n');
    process.stderr.write(dim('  Create one: midnight wallet generate <name> --network <name>') + '\n\n');
    return;
  }

  process.stderr.write('\n' + header('Wallets') + '\n\n');

  // Compact one-line layout — name + truncated unshielded + truncated shielded.
  // Columns padded to the widest entry so addresses align. Full per-network
  // detail (untruncated, all 3 networks) lives in `mn wallet info <name>`.
  const nameWidth = Math.max(...wallets.map((w) => w.name.length));
  const ADDR_WIDTH = 19;     // formatAddress(_, true) renders as `<10>…<8>` = 19 chars
  const SHIELDED_WIDTH = 19; // same truncation rule

  // Header row
  const namePad = ' '.repeat(nameWidth - 'name'.length);
  process.stderr.write(
    `    ${dim('name')}${namePad}  ${dim('unshielded'.padEnd(ADDR_WIDTH))}  ${dim('shielded')}\n`,
  );

  for (const w of wallets) {
    const marker = w.isActive ? green('●') : ' ';
    const nameStr = w.isActive ? bold(teal(w.name)) : teal(w.name);
    const padding = ' '.repeat(nameWidth - w.name.length);
    const unshielded = w.addresses[networkName] ?? '(unknown)';
    const shielded = w.shieldedAddresses?.[networkName];
    const shieldedCell = shielded ? formatAddress(shielded, true) : dim('—'.padEnd(SHIELDED_WIDTH));
    process.stderr.write(
      `  ${marker} ${nameStr}${padding}  ${formatAddress(unshielded, true)}  ${shieldedCell}\n`,
    );
  }

  process.stderr.write('\n' + divider() + '\n');
  process.stderr.write(dim(`  ● = active wallet · network: ${networkName} · details: midnight wallet info <name>`) + '\n\n');
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
  const networkName = resolveNetworkName({ args });
  const activeAddress = config.addresses[networkName];

  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = {
      name,
      addresses: config.addresses,
      activeAddress,
      activeNetwork: networkName,
      createdAt: config.createdAt,
      file: walletPath,
      active: isActive,
    };
    if (config.shieldedAddresses) result.shieldedAddresses = config.shieldedAddresses;
    writeJsonResult(result);
    return;
  }

  // Bare active address to stdout (pipeable)
  process.stdout.write(activeAddress + '\n');

  // Header with wallet name inline
  process.stderr.write('\n' + header(`Wallet: ${name}`) + '\n\n');

  // Per-network grouping — unshielded + shielded together
  const networks = Object.keys(config.addresses) as Array<keyof typeof config.addresses>;
  for (let i = 0; i < networks.length; i++) {
    const network = networks[i] as string;
    const isActiveNet = network === networkName;
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
  process.stderr.write(`  ${dim('file   ')}  ${walletPath}\n`);
  process.stderr.write(`  ${dim('active ')}  ${isActive ? green('yes') : 'no'}\n\n`);
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

async function walletSeed(args: ParsedArgs): Promise<void> {
  const name = args.positionals[0] ?? getActiveWalletName();
  const walletPath = resolveWalletPath(name);

  // Read raw JSON to get seed + mnemonic directly from file
  const fs = await import('fs');
  const raw = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));

  if (!raw.seed) {
    throw new Error(`Wallet "${name}" has no seed in ${walletPath}`);
  }

  // `--entropy` adds the 32-byte BIP-39 entropy (derived from the mnemonic)
  // alongside the 64-byte PBKDF2 seed. They're DIFFERENT values that produce
  // DIFFERENT Midnight wallets — use the format your target project expects.
  const includeEntropy = hasFlag(args, 'entropy');
  let entropyHex: string | undefined;
  if (includeEntropy) {
    if (!raw.mnemonic) {
      throw new Error(
        `Wallet "${name}" has no mnemonic on file — cannot derive BIP-39 entropy.\n` +
        `The 32-byte entropy can only be computed from the original 24-word mnemonic.`,
      );
    }
    entropyHex = Buffer.from(mnemonicToEntropy(raw.mnemonic, wordlist)).toString('hex');
  }

  // JSON mode — no interactive prompt, just output
  if (hasFlag(args, 'json')) {
    const result: Record<string, unknown> = { name, seed: raw.seed };
    if (raw.mnemonic) result.mnemonic = raw.mnemonic;
    if (entropyHex) result.entropy = entropyHex;
    writeJsonResult(result);
    return;
  }

  // Warning + confirmation
  process.stderr.write('\n');
  process.stderr.write(yellow(bold('  ⚠ WARNING: This will display your wallet seed and mnemonic.')) + '\n');
  process.stderr.write(yellow('  Anyone with this seed can access your funds.') + '\n');
  process.stderr.write(yellow('  Never share it. Never paste it into a website.') + '\n');
  process.stderr.write('\n');

  const confirmed = await confirm('  Show seed? (y/N) ');
  if (!confirmed) {
    process.stderr.write(dim('  Cancelled.') + '\n\n');
    return;
  }

  // Seed to stdout (pipeable)
  process.stdout.write(raw.seed + '\n');

  // Details to stderr
  process.stderr.write('\n');
  process.stderr.write(keyValue('Name', name) + '\n');
  process.stderr.write(keyValue('Seed (64-byte PBKDF2)', raw.seed) + '\n');
  if (entropyHex) {
    process.stderr.write(keyValue('Entropy (32-byte BIP-39)', entropyHex) + '\n');
  }
  if (raw.mnemonic) {
    process.stderr.write(keyValue('Mnemonic', raw.mnemonic) + '\n');
  }
  process.stderr.write(keyValue('File', walletPath) + '\n');
  if (entropyHex) {
    process.stderr.write('\n');
    process.stderr.write(dim('  Note: seed and entropy derive DIFFERENT Midnight wallets from the') + '\n');
    process.stderr.write(dim('  same mnemonic. Use the value your target project accepts.') + '\n');
  }
  process.stderr.write('\n');
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const readline = require('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer: string) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}
