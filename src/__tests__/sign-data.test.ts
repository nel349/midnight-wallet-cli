import { describe, expect, it } from 'vitest';
import { signedMessageBytes } from '../lib/sign-data.ts';

describe('signedMessageBytes', () => {
  it('puts "midnight_signed_message:<byte length>:" before the bytes', () => {
    expect(Buffer.from(signedMessageBytes(new Uint8Array(32).fill(0xab))).toString('hex'))
      .toBe(Buffer.from('midnight_signed_message:32:').toString('hex') + 'ab'.repeat(32));
  });

  it('counts bytes, not characters', () => {
    expect(Buffer.from(signedMessageBytes(new Uint8Array(Buffer.from('héllo', 'utf-8')))).toString('utf-8'))
      .toBe('midnight_signed_message:6:héllo');
  });

  it('prefixes empty data too', () => {
    expect(Buffer.from(signedMessageBytes(new Uint8Array())).toString('utf-8')).toBe('midnight_signed_message:0:');
  });
});
