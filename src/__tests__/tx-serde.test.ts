import { describe, it, expect } from 'vitest';
import { toHex, fromHex } from '../lib/tx-serde.ts';

describe('tx-serde', () => {
  describe('toHex', () => {
    it('converts empty Uint8Array to empty string', () => {
      expect(toHex(new Uint8Array([]))).toBe('');
    });

    it('converts bytes to lowercase hex', () => {
      expect(toHex(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]))).toBe('00ffa73f');
    });

    it('pads single-digit values with leading zero', () => {
      expect(toHex(new Uint8Array([0, 1, 2, 15]))).toBe('0001020f');
    });
  });

  describe('fromHex', () => {
    it('converts empty string to empty Uint8Array', () => {
      expect(fromHex('')).toEqual(new Uint8Array([]));
    });

    it('converts lowercase hex to bytes', () => {
      expect(fromHex('00ffa73f')).toEqual(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]));
    });

    it('converts uppercase hex to bytes', () => {
      expect(fromHex('00FFA73F')).toEqual(new Uint8Array([0x00, 0xff, 0xa7, 0x3f]));
    });

    it('converts mixed-case hex to bytes', () => {
      expect(fromHex('aAbBcC')).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
    });

    it('throws on non-hex characters', () => {
      expect(() => fromHex('xyz123')).toThrow('non-hex characters');
    });

    it('throws on odd-length hex string', () => {
      expect(() => fromHex('abc')).toThrow('odd length');
    });
  });

  describe('round-trip', () => {
    it('toHex(fromHex(hex)) returns original hex (lowercase)', () => {
      const hex = 'deadbeef01020304';
      expect(toHex(fromHex(hex))).toBe(hex);
    });

    it('fromHex(toHex(bytes)) returns original bytes', () => {
      const bytes = new Uint8Array([0, 128, 255, 42, 99]);
      expect(fromHex(toHex(bytes))).toEqual(bytes);
    });
  });
});
