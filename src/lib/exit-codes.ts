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
  PROOF_TIMEOUT: 'PROOF_TIMEOUT',
  DUST_REQUIRED: 'DUST_REQUIRED',
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
 */
export function classifyError(err: Error): ClassifiedError {
  const msg = err.message.toLowerCase();

  // Cancelled by user (SIGINT / AbortController)
  if (msg.includes('cancelled') || msg.includes('aborted')) {
    return { exitCode: EXIT_CANCELLED, errorCode: ERROR_CODES.CANCELLED };
  }

  // Wallet file not found
  if (msg.includes('wallet file not found') || msg.includes('wallet') && msg.includes('not found')) {
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

  // Dust required
  if (msg.includes('dust')) {
    return { exitCode: EXIT_INSUFFICIENT_BALANCE, errorCode: ERROR_CODES.DUST_REQUIRED };
  }

  // Stale UTXO
  if (msg.includes('stale') || msg.includes('115')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.STALE_UTXO };
  }

  // Proof timeout
  if (msg.includes('proof') && msg.includes('timeout')) {
    return { exitCode: EXIT_TX_REJECTED, errorCode: ERROR_CODES.PROOF_TIMEOUT };
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
    msg.includes('connection') ||
    msg.includes('network') && msg.includes('error')
  ) {
    return { exitCode: EXIT_NETWORK_ERROR, errorCode: ERROR_CODES.NETWORK_ERROR };
  }

  // Fallback
  return { exitCode: EXIT_GENERAL_ERROR, errorCode: ERROR_CODES.UNKNOWN };
}
