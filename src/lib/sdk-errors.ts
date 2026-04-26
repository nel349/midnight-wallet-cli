// SDK error classifiers — pattern-match opaque SDK / chain errors into
// categories the rest of the codebase can branch on. Pure functions, no
// side effects, no I/O. Lives in its own file so both transfer.ts and
// wallet-data-repository.ts can import without a circular dependency.

/**
 * The chain rejected the transaction outright. Most commonly: balance check
 * failed because the dust capacity wasn't sufficient at submission time
 * (BalanceCheckOverspend) — the estimated dust capacity hasn't grown
 * large enough to cover the tx fee yet.
 *
 * The SDK throws a generic "Transaction submission error" without the
 * actual error code (138). The code is only printed to console by
 * polkadot-js. So we match on the submission error message pattern
 * plus any "138" in the cause chain as a fallback.
 */
export function isTransactionRejectedError(err: any): boolean {
  let current = err;
  while (current) {
    const msg = String(current?.message ?? '').toLowerCase();
    if (msg.includes('submission error')) return true;
    if (msg.includes('transaction') && msg.includes('invalid')) return true;
    if (msg.includes('138')) return true;
    const tag = current?._tag;
    if (tag === 'TransactionInvalidError' || tag === 'SubmissionError') return true;
    current = current.cause;
  }
  return false;
}

/**
 * Dust-related — the SDK throws various messages when dust capacity is too
 * low to pay fees. All of these are retryable by waiting for dust generation
 * capacity to grow.
 */
export function isDustRelatedError(err: any): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  return msg.includes('not enough dust') ||
    msg.includes('dust generated') ||
    msg.includes('insufficient funds') ||
    msg.includes('no dust tokens') ||
    isTransactionRejectedError(err);
}

/**
 * The SDK's `Wallet.InsufficientFunds` error surfaced from
 * `transferTransaction`. Distinct from our own pre-flight "Insufficient
 * balance" (which starts with "Insufficient balance:"). The SDK raises
 * this from `#balanceSegment` when its internal coin index is empty —
 * which on a freshly-started localnet can happen even though the state
 * snapshot the facade just emitted shows UTXOs. Recovery is a full
 * facade restart, not an in-place quick-sync.
 */
export function isSdkInsufficientFundsError(err: any): boolean {
  const msg = err?.message?.toLowerCase() ?? '';
  const tag = err?._tag;
  if (tag === 'Wallet.InsufficientFunds') return true;
  return msg === 'insufficient funds' || msg.startsWith('insufficient funds');
}
