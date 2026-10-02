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

/** Where an Effect `FiberFailure` (what an SDK promise rejects with) keeps the failure it ran into. */
const FIBER_FAILURE_CAUSE = Symbol.for('effect/Runtime/FiberFailure/Cause');

/**
 * The wallet ran out of dust to pay a fee, which waiting for dust can fix.
 * wallet-sdk 2.0 raises a tagged `Wallet.InsufficientFunds` with
 * `tokenType: 'dust'`. Its promises reject with an Effect `FiberFailure` that
 * carries the tagged error only inside its cause, possibly also wrapped as a
 * `cause` by the facade. A shortage of any other token is not this. The
 * ledger-8 SDK said "No dust tokens" or "dust ... unavailable".
 */
export function isDustShortage(err: unknown): boolean {
  const seen = new Set<unknown>();
  const pending: unknown[] = [err];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const e = current as Record<PropertyKey, unknown>;
    if (e._tag === 'Wallet.InsufficientFunds' && e.tokenType === 'dust') return true;
    if (typeof e.message === 'string' && /no dust tokens|dust.*unavailable/i.test(e.message)) return true;
    // Error causes, an Effect Cause's failure or defect, and the halves of a combined Cause.
    pending.push(e.cause, e[FIBER_FAILURE_CAUSE], e.error, e.defect, e.left, e.right);
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
    msg.includes('insufficient generated dust') ||
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
