// Structured exit codes and error classification for CLI
// Used by both JSON mode and non-JSON error reporting

// ── Exit codes ──────────────────────────────────────────
export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL_ERROR = 1;
export const EXIT_INVALID_ARGS = 2;
export const EXIT_WALLET_NOT_FOUND = 3;
export const EXIT_NETWORK_ERROR = 4;
export const EXIT_INSUFFICIENT_BALANCE = 5;
export const EXIT_TX_REJECTED = 6;
export const EXIT_CANCELLED = 7;

// ── Machine-readable error code strings ─────────────────
export const ERROR_CODES = {
  INVALID_ARGS: 'INVALID_ARGS',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  TX_REJECTED: 'TX_REJECTED',
  STALE_UTXO: 'STALE_UTXO',
  /** Local wallet cache disagrees with chain state (e.g. localnet reset, remote testnet re-index). Recovery: `mn cache clear --wallet <name>` then retry. */
  STALE_CACHE: 'STALE_CACHE',
  PROOF_TIMEOUT: 'PROOF_TIMEOUT',
  /** Proof server rejected or failed to generate the ZK proof for a write transaction. Often a stale commitment tree or an unreachable proof server. Recovery: ensure proof server is running, then retry; if persistent, `mn cache clear` to force a fresh sync. */
  PROOF_FAILURE: 'PROOF_FAILURE',
  /** Chain rejected the dust spend proof as malformed (substrate "Custom error 170" / `InvalidDustSpendProof`). Almost always a stale commitment tree. Recovery: `mn cache clear --wallet <name>` then retry. */
  INVALID_DUST_PROOF: 'INVALID_DUST_PROOF',
  DUST_REQUIRED: 'DUST_REQUIRED',
  /** Long-running wallet sync exceeded its deadline. On hosted networks this is most common during the first cold sync; retrying usually progresses since the cache resumes from the last applied event. */
  SYNC_TIMEOUT: 'SYNC_TIMEOUT',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = typeof ERROR_CODES[keyof typeof ERROR_CODES];

interface ClassifiedError {
  exitCode: number;
  errorCode: ErrorCode;
}

/**
 * Inspect an error message to determine the appropriate exit code and error code.
 * Pattern-matches against known error messages from the CLI and Midnight SDK.
 * Order matters: more specific patterns are checked before broader ones.
 */
export function classifyError(err: Error): ClassifiedError {
  const msg = (err.message ?? '').toLowerCase();

  // Cancelled by user (SIGINT / AbortController)
  if (msg.includes('operation cancelled') || msg.includes('operation aborted') || msg === 'cancelled' || msg === 'aborted') {
    return { exitCode: EXIT_CANCELLED, errorCode: ERROR_CODES.CANCELLED };
  }

  // Wallet file not found
  if (msg.includes('wallet file not found') || (msg.includes('wallet') && msg.includes('not found'))) {
    return { exitCode: EXIT_WALLET_NOT_FOUND, errorCode: ERROR_CODES.WALLET_NOT_FOUND };
  }

  // Invalid arguments / usage errors
  if (
    msg.includes('missing required flag') ||
    msg.includes('missing amount') ||
    msg.includes('missing recipient') ||
    msg.includes('missing config key') ||
    msg.includes('missing or invalid subcommand') ||
    msg.includes('unknown command') ||
    msg.includes('cannot specify both') ||
    msg.includes('invalid bip-39') ||
    msg.includes('seed must be') ||
    msg.includes('key index must be') ||
    msg.includes('usage:')
  ) {
    return { exitCode: EXIT_INVALID_ARGS, errorCode: ERROR_CODES.INVALID_ARGS };
  }

  // Proof timeout (before general timeout/dust checks)
  if (msg.includes('proof') && msg.includes('timeout')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.PROOF_TIMEOUT };
  }

  // Stale UTXO — match the specific error code from the Midnight node
  if (msg.includes('stale utxo') || msg.includes('error code 115') || msg.includes('errorcode: 115')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.STALE_UTXO };
  }

  // Invalid dust spend proof — substrate "Custom error 170". Distinct from
  // PROOF_FAILURE because the recovery is "clear cache" not "retry".
  if (msg.includes('error 170') || msg.includes('errorcode: 170') || msg.includes('invaliddustspendproof')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.INVALID_DUST_PROOF };
  }

  // Stale local cache (e.g. `applied > highest`, `chainId mismatch`)
  if (msg.includes('stale cache') || msg.includes('chain reset') || msg.includes('chainid mismatch') || msg.includes('applied > highest')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.STALE_CACHE };
  }

  // Proof server failure — SDK ClientError "Failed to prove transaction".
  if (msg.includes('failed to prove')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.PROOF_FAILURE };
  }

  // Sync timeouts — wallet sync, dust waits, indexer waits.
  if (
    msg.includes('wallet sync timed out') ||
    msg.includes('sync timed out') ||
    msg.includes('timed out waiting for dust') ||
    msg.includes('did not respond within') ||
    msg.includes('did not produce a block') ||
    msg.includes('did not report funds')
  ) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.SYNC_TIMEOUT };
  }

  // Dust required — match specific dust-related failures
  if (msg.includes('no dust') || msg.includes('dust') && (msg.includes('required') || msg.includes('available') || msg.includes('insufficient'))) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED };
  }

  // Insufficient balance
  if (msg.includes('insufficient') || msg.includes('not enough')) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.INSUFFICIENT_BALANCE };
  }

  // Transaction rejected
  if (msg.includes('rejected') || msg.includes('transaction failed')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.TX_REJECTED };
  }

  // Network / connection errors
  if (
    msg.includes('econnrefused') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    msg.includes('websocket') ||
    msg.includes('connection refused') ||
    (msg.includes('network') && msg.includes('error'))
  ) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.NETWORK_ERROR };
  }

  // Fallback
  return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN };
}
