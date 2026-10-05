// Decoding the data a dApp asks the wallet to sign: strictly, so the wallet
// never signs bytes other than the ones the dApp meant.

import { describe, expect, it } from 'vitest';
import { decodeSignPayload } from '../lib/sign-data.ts';

describe('decodeSignPayload', () => {
  it('decodes hex, base64 and text to the same bytes', () => {
    const bytes = [0x68, 0x65, 0x6c, 0x6c, 0x6f];
    expect([...decodeSignPayload('68656c6c6f', 'hex')]).toEqual(bytes);
    expect([...decodeSignPayload('aGVsbG8=', 'base64')]).toEqual(bytes);
    expect([...decodeSignPayload('hello', 'text')]).toEqual(bytes);
  });

  // Found live: Node decoded "@@@not base64@@@" by skipping what it didn't know, and mn signed the result.
  it.each(['@@@not base64@@@', 'aGVsbG8', 'aGV sbG8=', 'aGVsbG8=='])('refuses invalid base64 %j', (data) => {
    expect(() => decodeSignPayload(data, 'base64')).toThrow('data is not valid base64');
  });

  it('refuses invalid hex and unknown encodings, saying which', () => {
    expect(() => decodeSignPayload('zz', 'hex')).toThrow('data is not valid hex');
    expect(() => decodeSignPayload('abc', 'hex')).toThrow('data is not valid hex');
    expect(() => decodeSignPayload('x', 'binary')).toThrow('Unknown encoding: binary (use hex, base64 or text)');
  });
});
