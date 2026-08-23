// One shared wallet-seed resolver for the commands that operate on a seed
// (`address`, `balance`, `dust export`). They used to each parse `--seed` /
// `MN_SEED` / `--wallet` separately, which is how `balance` drifted and never
// learned `MN_SEED`. Centralizing it keeps the precedence identical everywhere.

import { getFlag, type ParsedArgs } from './argv.ts';
import { UsageError } from './errors.ts';
import { loadWalletConfig, resolveWalletPath, type WalletConfig } from './wallet-config.ts';

export interface ResolvedSeed {
  /** The 32-byte wallet seed. */
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
 * Resolve a wallet seed with uniform precedence:
 *   `--seed <hex>` → `MN_SEED` (env, kept off the process list) → `--wallet <name>` → active wallet.
 * Returns the seed plus the backing wallet file/config (both null for a `--seed` / `MN_SEED`
 * source), so a caller that caches to the wallet file can skip that when there is none.
 */
export function resolveSeedSource(args: ParsedArgs, opts: ResolveSeedOptions = {}): ResolvedSeed {
  const seedFlag = getFlag(args, 'seed');
  const seedSource = seedFlag ?? process.env.MN_SEED;
  if (seedSource) {
    // Trim first — a seed from a file / command substitution (MN_SEED=$(cat seed.hex))
    // carries a trailing newline that would fail the length check.
    const seedHex = seedSource.trim().replace(/^0x/, '');
    if (seedHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(seedHex)) {
      throw new UsageError(`${seedFlag ? '--seed' : 'MN_SEED'} must be a 64-character hex string (32 bytes)`);
    }
    return { seed: Buffer.from(seedHex, 'hex'), walletPath: null, config: null };
  }

  const walletName = getFlag(args, 'wallet');
  if (walletName === undefined && opts.requireExplicit) {
    throw new UsageError(
      `${opts.label ?? 'This command'} needs a seed source. Provide one of:\n` +
      '  --seed <hex>     32-byte seed as 64 hex characters\n' +
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
