// Resolves the 32-byte secret seeded into a contract's initial private state.
// Shared between the bridge runner (where it executes via `.toString()`-inlining
// into the generated deploy/call script) and the test suite (where it's called
// directly) — one source, so every branch is unit-tested without a child process.
//
// Written in plain ES2017+ JS-friendly TS so its `toString()` form is portable
// across Node versions (same constraint as arg-coerce.ts).

/**
 * Pick the private-state secret, in precedence order:
 *   1. `injectedHex` — an explicit caller secret (mn deploy `--secret-key`,
 *      delivered via env), for a contract whose constructor reads its owner from
 *      a witness (owner = public_key(secret_key())).
 *   2. the wallet's coin public key — a deterministic per-wallet key, so repeated
 *      calls (post/takeDown) reuse the same secret across CLI invocations.
 *   3. a random key — last resort when no wallet key is available.
 */
export function resolvePrivateStateSecretKey(
  injectedHex: string | undefined,
  walletCoinPublicKey: string | undefined,
): Uint8Array {
  const key = new Uint8Array(32);
  if (injectedHex && injectedHex.length === 64) {
    for (let i = 0; i < 32; i++) key[i] = parseInt(injectedHex.substr(i * 2, 2), 16);
    return key;
  }
  const cpk = walletCoinPublicKey ?? '';
  if (cpk.length >= 64) {
    for (let i = 0; i < 32; i++) key[i] = parseInt(cpk.substr(i * 2, 2), 16);
    return key;
  }
  globalThis.crypto.getRandomValues(key);
  return key;
}
