import { describe, it, expect } from 'vitest';
import { coerceArg } from '../lib/contract/arg-coerce.ts';

describe('coerceArg', () => {
  // ── Scalars ──

  it('coerces number to BigInt', () => {
    expect(coerceArg(0)).toBe(0n);
    expect(coerceArg(42)).toBe(42n);
    expect(coerceArg(-1)).toBe(-1n);
  });

  it('passes plain strings through unchanged', () => {
    expect(coerceArg('hello')).toBe('hello');
    expect(coerceArg('')).toBe('');
    expect(coerceArg('0x1234')).toBe('0x1234');
    // No accidental hex detection — strings stay strings.
    expect(coerceArg('1234')).toBe('1234');
  });

  it('parses BigInt literal strings ("123n") as BigInt', () => {
    expect(coerceArg('0n')).toBe(0n);
    expect(coerceArg('42n')).toBe(42n);
    expect(coerceArg('-1n')).toBe(-1n);
    // 256-bit field element — the case that motivated this feature.
    expect(coerceArg('3577394479284403670236348992777191201732840986765319885002601601785304458706n'))
      .toBe(3577394479284403670236348992777191201732840986765319885002601601785304458706n);
  });

  it('does not treat "n"-suffixed non-digits as bigint', () => {
    // Only digits-then-n is a BigInt literal. Anything else is a plain string.
    expect(coerceArg('foo n')).toBe('foo n');
    expect(coerceArg('12.3n')).toBe('12.3n');
    expect(coerceArg('n')).toBe('n');
  });

  it('passes booleans, null, undefined unchanged', () => {
    expect(coerceArg(true)).toBe(true);
    expect(coerceArg(false)).toBe(false);
    expect(coerceArg(null)).toBe(null);
    expect(coerceArg(undefined)).toBe(undefined);
  });

  it('passes existing bigints through unchanged', () => {
    expect(coerceArg(123n)).toBe(123n);
  });

  // ── Bytes detection ──

  it('converts byte arrays (all ints in [0, 255]) to Uint8Array', () => {
    const out = coerceArg([0, 1, 254, 255]);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out as Uint8Array)).toEqual([0, 1, 254, 255]);
  });

  it('coerces a 32-byte zero-filled array to Uint8Array', () => {
    const input = Array.from({ length: 32 }, () => 0);
    const out = coerceArg(input);
    expect(out).toBeInstanceOf(Uint8Array);
    expect((out as Uint8Array).length).toBe(32);
  });

  it('does not treat empty arrays as Uint8Array', () => {
    // Compact circuits with empty Vector args should pass through as [].
    expect(coerceArg([])).toEqual([]);
  });

  it('does not treat number arrays with values out of [0, 255] as Uint8Array', () => {
    const out = coerceArg([1, 2, 999]);
    expect(out).not.toBeInstanceOf(Uint8Array);
    // Each element is recursed: numbers become bigints.
    expect(out).toEqual([1n, 2n, 999n]);
  });

  it('does not treat number arrays with non-integers as Uint8Array', () => {
    const out = coerceArg([0.5, 1, 2]);
    expect(out).not.toBeInstanceOf(Uint8Array);
  });

  // ── Recursive coercion ──

  it('recurses into objects (Struct args)', () => {
    const out = coerceArg({ x: 1, y: 'foo', z: '42n' }) as Record<string, unknown>;
    expect(out.x).toBe(1n);
    expect(out.y).toBe('foo');
    expect(out.z).toBe(42n);
  });

  it('handles registerProvider-style {x: bigint, y: bigint} object', () => {
    const out = coerceArg({
      x: '3577394479284403670236348992777191201732840986765319885002601601785304458706n',
      y: '5455399229761624761921530609908108928244637380942634627455764517737954405162n',
    }) as Record<string, bigint>;
    expect(typeof out.x).toBe('bigint');
    expect(typeof out.y).toBe('bigint');
    expect(out.x).toBe(3577394479284403670236348992777191201732840986765319885002601601785304458706n);
    expect(out.y).toBe(5455399229761624761921530609908108928244637380942634627455764517737954405162n);
  });

  it('recurses into arrays of mixed values', () => {
    const out = coerceArg([1, 'name', { v: 7 }]) as unknown[];
    expect(out[0]).toBe(1n);
    expect(out[1]).toBe('name');
    expect(out[2]).toEqual({ v: 7n });
  });

  it('recurses into nested objects', () => {
    const out = coerceArg({
      outer: { inner: { value: '999n' } },
    }) as { outer: { inner: { value: unknown } } };
    expect(out.outer.inner.value).toBe(999n);
  });

  // ── End-to-end shape: registerProvider call ──

  it('coerces a [providerId, providerPk] tuple as Compact circuit args expect', () => {
    const args = [
      1,
      {
        x: '3577394479284403670236348992777191201732840986765319885002601601785304458706n',
        y: '5455399229761624761921530609908108928244637380942634627455764517737954405162n',
      },
    ];
    const out = args.map(coerceArg);
    expect(out[0]).toBe(1n);
    const pk = out[1] as { x: bigint; y: bigint };
    expect(typeof pk.x).toBe('bigint');
    expect(typeof pk.y).toBe('bigint');
  });
});
