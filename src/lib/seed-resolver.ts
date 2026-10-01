// One shared wallet-seed resolver for the commands that operate on a seed
// (`address`, `balance`, `dust export`). They used to each parse `--seed` /
// `MN_SEED` / `--wallet` separately, which is how `balance` drifted and never
// learned `MN_SEED`. Centralizing it keeps the precedence identical everywhere.

import { getFlag, type ParsedArgs } from './argv.ts';
import { UsageError } from './errors.ts';
import { loadWalletConfig, resolveWalletPath, type WalletConfig } from './wallet-config.ts';

export interface ResolvedSeed {
  /** The wallet seed: 32-byte raw, or 64-byte BIP-39 (mnemonic-derived). */
  seed: Buffer;
  /** The wallet file the seed came from, or null when supplied via `--seed` / `MN_SEED`. */
  walletPath: string | null;
  /** The loaded wallet config, or null for a `--seed` / `MN_SEED` source (no file). */
  config: WalletConfig | null;
}

export interface ResolveSeedOptions {
  /**
   * Disable the active-wallet fallback and error clearly when no source is given.
   * Used by `address` (a seed-derivation tool with no notion of a "current" wallet).
   */
  requireExplicit?: boolean;
  /** Command name for the `requireExplicit` error (e.g. `address needs a seed source`). */
  label?: string;
}

/**
 * Parse a hex seed. Accepts the two seed sizes that actually occur:
 *   - 64 hex chars — a 32-byte raw seed
 *   - 128 hex chars — a 64-byte BIP-39 seed (mnemonicToSeedSync output), so a
 *     wallet derived elsewhere from a mnemonic can be cross-checked here
 * HD derivation (SLIP-10) technically takes 128–512 bits, but gating to the
 * two real sizes means a typo can't silently derive a different wallet.
 */
export function parseSeedHex(input: string, label: string): Buffer {
  // Trim first — a seed from a file / command substitution (MN_SEED=$(cat seed.hex))
  // carries a trailing newline that would fail the length check.
  const hex = input.trim().replace(/^0x/, '');
  if ((hex.length !== 64 && hex.length !== 128) || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new UsageError(
      `${label} must be 64 or 128 hex characters (a 32-byte seed, or a 64-byte BIP-39 seed)`
    );
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Resolve a wallet seed with uniform precedence:
 *   `--seed <hex>` → `MN_SEED` (env, kept off the process list) → `--wallet <name>` → active wallet.
 * Returns the seed plus the backing wallet file/config (both null for a `--seed` / `MN_SEED`
 * source), so a caller that caches to the wallet file can skip that when there is none.
 */
export function resolveSeedSource(args: ParsedArgs, opts: ResolveSeedOptions = {}): ResolvedSeed {
  const seedFlag = getFlag(args, 'seed');
  const seedSource = seedFlag ?? process.env.MN_SEED;
  if (seedSource) {
    return {
      seed: parseSeedHex(seedSource, seedFlag ? '--seed' : 'MN_SEED'),
      walletPath: null,
      config: null,
    };
  }

  const walletName = getFlag(args, 'wallet');
  if (walletName === undefined && opts.requireExplicit) {
    throw new UsageError(
      `${opts.label ?? 'This command'} needs a seed source. Provide one of:\n` +
      '  --seed <hex>     seed as 64 hex chars (32-byte) or 128 (64-byte BIP-39)\n' +
      '  MN_SEED=<hex>    same seed via env (kept off the process list)\n' +
      '  --wallet <name>  derive from a saved wallet',
    );
  }

  const walletPath = resolveWalletPath(walletName);
  const config = loadWalletConfig(walletPath);
  return { seed: Buffer.from(config.seed, 'hex'), walletPath, config };
}

/** Just the seed — for commands that don't touch the wallet file. */
export function resolveSeed(args: ParsedArgs, opts?: ResolveSeedOptions): Buffer {
  return resolveSeedSource(args, opts).seed;
}
