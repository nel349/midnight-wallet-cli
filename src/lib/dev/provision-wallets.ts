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

/** The three steps of setting up a wallet; the defaults run mn's own commands. */
export interface ProvisionSteps {
  generate: (name: string, signal?: AbortSignal) => Promise<void>;
  airdrop: (name: string, amountNight: number, signal?: AbortSignal) => Promise<void>;
  registerDust: (name: string, signal?: AbortSignal) => Promise<void>;
}

export interface ProvisionOptions {
  names: readonly string[];
  amountNight: number;
  onProgress?: (wallet: string, phase: 'creating' | 'funding' | 'dust' | 'done', state: WalletProvisionState) => void;
  signal?: AbortSignal;
  steps?: ProvisionSteps;
}

const COMMAND_STEPS: ProvisionSteps = {
  generate: invokeWalletGenerate,
  airdrop: invokeAirdrop,
  registerDust: invokeDustRegister,
};

/**
 * Ensure each wallet exists, is funded from genesis, and is dust-registered.
 * Only runs create → airdrop → dust for brand-new wallets; reuses existing ones as-is.
 * Always targets the `undeployed` network — airdrop is localnet-only.
 *
 * Every new wallet is funded before any registers: a ledger-9 registration
 * waits for its NIGHT to generate the fee (about a minute for 1000 NIGHT),
 * and generation starts at the airdrop, so the later wallets' waits run
 * while the earlier ones register instead of one after another.
 */
export async function provisionDevWallets(opts: ProvisionOptions): Promise<ProvisionedWallet[]> {
  const steps = opts.steps ?? COMMAND_STEPS;
  const results: ProvisionedWallet[] = [];
  const created: string[] = [];

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
      await steps.generate(name, opts.signal);

      opts.onProgress?.(name, 'funding', 'created');
      await steps.airdrop(name, opts.amountNight, opts.signal);
      created.push(name);
    }

    for (const name of created) {
      opts.signal?.throwIfAborted();
      opts.onProgress?.(name, 'dust', 'created');
      await steps.registerDust(name, opts.signal);

      opts.onProgress?.(name, 'done', 'created');
      results.push({ name, state: 'created' });
    }
  } finally {
    restoreActiveWallet(previousActive);
  }

  return opts.names.flatMap((name) => results.filter((r) => r.name === name));
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
