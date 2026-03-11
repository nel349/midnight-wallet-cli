// Genesis wallet seed (seed 0x01) — used for local devnet funding
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

// Native NIGHT token type (all zeros, 32 bytes hex)
export const NATIVE_TOKEN_TYPE = '0000000000000000000000000000000000000000000000000000000000000000';

// NIGHT has 6 decimal places (1 NIGHT = 1_000_000 micro-NIGHT)
export const TOKEN_DECIMALS = 6;
export const TOKEN_MULTIPLIER = 1_000_000;

// Dust wallet cost parameters — matches the reference implementation.
// The SDK uses: feesWithMargin(ledgerParams, feeBlocksMargin) + additionalFeeOverhead
// Reference (kuira-verification-test): 300T overhead, 5 blocks margin.
export const DUST_COST_OVERHEAD = 300_000_000_000_000n;
export const DUST_FEE_BLOCKS_MARGIN = 5;

// Minimum dust balance for a transfer transaction.
// The actual fee = feesWithMargin(tx, ledgerParams, feeBlocksMargin) + DUST_COST_OVERHEAD.
// We can't compute the exact feesWithMargin without building the transaction, but
// observed costs are ~0.5 DUST per unshielded transfer. 0.6 DUST gives headroom.
// Used as a pre-flight check to fail fast instead of entering the SDK's internal
// balancing which hangs or retries uselessly when dust is too low.
export const MIN_DUST_FOR_TRANSFER = 800_000_000_000_000n;

// Timeouts (milliseconds)
export const SYNC_TIMEOUT_MS = 300_000;       // 5 minutes — full wallet sync (used by dust/balance commands)
export const SYNC_ATTEMPT_TIMEOUT_MS = 30_000; // 30 seconds — per sync attempt (transfer retries on timeout)
export const PRE_SEND_SYNC_TIMEOUT_MS = 10_000; // 10 seconds — quick sync before tx
export const DUST_TIMEOUT_MS = 120_000;        // 2 minutes — wait for dust generation
export const PROOF_TIMEOUT_MS = 300_000;       // 5 minutes — ZK proof generation
export const BALANCE_CHECK_TIMEOUT_MS = 60_000; // 1 minute — GraphQL balance subscription

// Transaction defaults
export const TX_TTL_MINUTES = 10;

// Retry configuration
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1_000; // 1s, 2s, 4s (exponential)

// Dust registration retry — on a fresh localnet, the estimated dust generation
// may be less than the registration fee until enough time has passed since UTXO
// creation. The SDK computes allow_fee_payment = (currentTime - utxo.ctime) * rate,
// which starts near zero and grows over time. Observed ~5 minutes on fresh localnets.
export const DUST_REGISTRATION_TIMEOUT_MS = 600_000; // 10 minutes max for registration retries
export const DUST_REGISTRATION_RETRY_DELAY_MS = 15_000; // 15 seconds between retries

// Error codes from the node
export const STALE_UTXO_ERROR_CODE = 115;
export const BALANCE_OVERSPEND_ERROR_CODE = 138;

// Default storage directory
export const MIDNIGHT_DIR = '.midnight';
export const DEFAULT_WALLET_FILENAME = 'wallet.json';
export const DEFAULT_CONFIG_FILENAME = 'config.json';

// File system permissions (POSIX octal)
export const DIR_MODE = 0o700;   // owner rwx only — directories holding sensitive files
export const FILE_MODE = 0o600;  // owner rw only — wallet files containing seeds/keys

// Localnet directory name (under ~/.midnight/)
export const LOCALNET_DIR_NAME = 'localnet';

// Wallet state cache
export const CACHE_VERSION = 1;
export const CACHE_DIR_NAME = 'cache';

// Multi-wallet support
export const WALLETS_DIR_NAME = 'wallets';
export const DEFAULT_WALLET_NAME = 'default';

/**
 * Validate a wallet name (not a path).
 * Rejects empty strings, path separators, '.json' suffix, '..' traversal,
 * and control characters. Returns true if the name is safe.
 */
export function isValidWalletName(name: string): boolean {
  if (!name || name !== name.trim()) return false;
  if (/[\/\\]/.test(name)) return false;
  if (name.endsWith('.json')) return false;
  if (name === '.' || name === '..') return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(name)) return false;
  return true;
}

// DApp Connector server port (99=midnight, 32=ws)
export const DEFAULT_SERVE_PORT = 9932;
