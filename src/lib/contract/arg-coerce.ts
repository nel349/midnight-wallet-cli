// Arg coercion shared between the bridge runner (where it executes via
// `.toString()`-inlining into a generated script) and the test suite (where
// it's called directly). Keeping a single source means we can unit-test
// every coercion path without spinning up a child process.
//
// The function is deliberately written in plain ES2017+ JS-friendly TS so
// its `toString()` form is portable across Node versions.

/**
 * Map a JSON-encodable arg into the runtime value Compact circuits expect.
 * See ARG_COERCE_FN in runner.ts for the full convention table.
 */
export function coerceArg(a: unknown): unknown {
  if (typeof a === 'number') {
    // Only safe-integer numbers convert to BigInt. Fractional numbers
    // pass through unchanged so they surface as a clear SDK type error
    // rather than a confusing "cannot convert non-integer to BigInt"
    // from our coercion. Compact has no float types — fractional input
    // is always a user error.
    return Number.isInteger(a) ? BigInt(a) : a;
  }
  if (typeof a === 'string') {
    // BigInt literal: trailing 'n' marks the value as bigint, mirroring
    // how the same literal is written in JS source ("123n" → 123n).
    if (/^-?\d+n$/.test(a)) return BigInt(a.slice(0, -1));
    return a;
  }
  if (Array.isArray(a)) {
    // Bytes<N> heuristic: a non-empty array of integers in [0, 255] is
    // overwhelmingly likely to be a byte buffer.
    if (a.length > 0 && a.every((x) => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 255)) {
      return Uint8Array.from(a as number[]);
    }
    return a.map(coerceArg);
  }
  if (a && typeof a === 'object' && Object.getPrototypeOf(a) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const k in a as Record<string, unknown>) {
      if (Object.prototype.hasOwnProperty.call(a, k)) {
        out[k] = coerceArg((a as Record<string, unknown>)[k]);
      }
    }
    return out;
  }
  return a;
}
