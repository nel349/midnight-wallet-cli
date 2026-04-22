// Dev wallet provisioning for `mn dev`.
// Creates a fixed set of named wallets on localnet, funds them from genesis,
// and registers them for dust. Idempotent — wallets that already exist are
// left untouched (the user can `mn wallet remove <name>` to force re-setup).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { captureCommand } from '../run-command.ts';
import { MIDNIGHT_DIR, WALLETS_DIR_NAME } from '../constants.ts';
import { getActiveWalletName, setActiveWallet } from '../wallet-config.ts';
import type { ParsedArgs } from '../argv.ts';

/** Default dev wallet names — one per common test persona. */
export const DEFAULT_DEV_WALLET_NAMES = ['dev-alice', 'dev-bob', 'dev-carol'] as const;

/** Default NIGHT amount to airdrop to each dev wallet. */
export const DEFAULT_DEV_AIRDROP_AMOUNT = 1000;

export type WalletProvisionState = 'reused' | 'created';

export interface ProvisionedWallet {
  name: string;
  state: WalletProvisionState;
}

export interface ProvisionOptions {
  names: readonly string[];
  amountNight: number;
  onProgress?: (wallet: string, phase: 'creating' | 'funding' | 'dust' | 'done', state: WalletProvisionState) => void;
  signal?: AbortSignal;
}

/**
 * Ensure each wallet exists, is funded from genesis, and is dust-registered.
 * Only runs create → airdrop → dust for brand-new wallets; reuses existing ones as-is.
 * Always targets the `undeployed` network — airdrop is localnet-only.
 */
export async function provisionDevWallets(opts: ProvisionOptions): Promise<ProvisionedWallet[]> {
  const results: ProvisionedWallet[] = [];

  // `wallet generate` sets the new wallet as active — remember the user's
  // current active wallet so we can restore it after provisioning.
  const previousActive = safeGetActiveWallet();

  try {
    for (const name of opts.names) {
      opts.signal?.throwIfAborted();

      if (walletExists(name)) {
        opts.onProgress?.(name, 'done', 'reused');
        results.push({ name, state: 'reused' });
        continue;
      }

      opts.onProgress?.(name, 'creating', 'created');
      await invokeWalletGenerate(name, opts.signal);

      opts.onProgress?.(name, 'funding', 'created');
      await invokeAirdrop(name, opts.amountNight, opts.signal);

      opts.onProgress?.(name, 'dust', 'created');
      await invokeDustRegister(name, opts.signal);

      opts.onProgress?.(name, 'done', 'created');
      results.push({ name, state: 'created' });
    }
  } finally {
    restoreActiveWallet(previousActive);
  }

  return results;
}

function safeGetActiveWallet(): string | null {
  try {
    return getActiveWalletName();
  } catch {
    return null;
  }
}

function restoreActiveWallet(name: string | null): void {
  if (!name) return;
  if (!walletExists(name)) return;
  try {
    setActiveWallet(name);
  } catch { /* best-effort */ }
}

// ── Internals ────────────────────────────────────────────────

function walletExists(name: string): boolean {
  const path = join(homedir(), MIDNIGHT_DIR, WALLETS_DIR_NAME, `${name}.json`);
  return existsSync(path);
}

async function invokeWalletGenerate(name: string, signal: AbortSignal | undefined): Promise<void> {
  const args: ParsedArgs = {
    command: 'wallet',
    subcommand: 'generate',
    positionals: [name],
    flags: { network: 'undeployed' },
  };
  const { default: handler } = await import('../../commands/wallet.ts');
  await captureCommand(handler, args, signal);
}

async function invokeAirdrop(name: string, amountNight: number, signal: AbortSignal | undefined): Promise<void> {
  const args: ParsedArgs = {
    command: 'airdrop',
    subcommand: String(amountNight),
    positionals: [],
    flags: { wallet: name, network: 'undeployed' },
  };
  const { default: handler } = await import('../../commands/airdrop.ts');
  await captureCommand(handler, args, signal);
}

async function invokeDustRegister(name: string, signal: AbortSignal | undefined): Promise<void> {
  const args: ParsedArgs = {
    command: 'dust',
    subcommand: 'register',
    positionals: [],
    flags: { wallet: name, network: 'undeployed' },
  };
  const { default: handler } = await import('../../commands/dust.ts');
  await captureCommand(handler, args, signal);
}
