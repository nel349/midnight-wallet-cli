// Per-method bigint conversion for JSON-RPC responses
// The server serializes bigint as string via JSON.stringify replacer.
// These functions convert known fields back to native bigint.

/**
 * Convert a balance record where all values are stringified bigints.
 * Used by getUnshieldedBalances and getShieldedBalances.
 */
export function reviveBalanceRecord(record: Record<string, string>): Record<string, bigint> {
  const result: Record<string, bigint> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = BigInt(value);
  }
  return result;
}

/**
 * Convert dust balance where cap and balance are stringified bigints.
 * Used by getDustBalance.
 */
export function reviveDustBalance(data: { cap: string; balance: string }): { cap: bigint; balance: bigint } {
  return {
    cap: BigInt(data.cap),
    balance: BigInt(data.balance),
  };
}
