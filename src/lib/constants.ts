// Genesis wallet seed (seed 0x01) — used for local devnet funding
export const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

// Native NIGHT token type (all zeros, 32 bytes hex)
export const NATIVE_TOKEN_TYPE = '0000000000000000000000000000000000000000000000000000000000000000';

// NIGHT has 6 decimal places (1 NIGHT = 1_000_000 micro-NIGHT)
export const TOKEN_DECIMALS = 6;
export const TOKEN_MULTIPLIER = 1_000_000;

// Dust wallet cost parameters
export const DUST_COST_OVERHEAD = 1_000_000_000_000n;
export const DUST_FEE_BLOCKS_MARGIN = 5;

// Timeouts (milliseconds)
export const SYNC_TIMEOUT_MS = 300_000;       // 5 minutes — full wallet sync
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
