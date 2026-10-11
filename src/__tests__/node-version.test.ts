import { describe, expect, it } from 'vitest';
import { MIN_NODE_MAJOR, UnsupportedNodeError, assertNodeSupported } from '../lib/node-version.ts';
import { classifyError } from '../lib/exit-codes.ts';

describe('assertNodeSupported', () => {
  it('accepts Node.js 22 and newer', () => {
    expect(MIN_NODE_MAJOR).toBe(22);
    for (const node of ['22.0.0', '22.18.0', '24.1.0', '25.3.0']) {
      expect(() => assertNodeSupported({ node })).not.toThrow();
    }
  });

  // Found by running published 0.5.4 on Node 20.10: a transfer failed with "Wallet sync timed out".
  it('refuses an older Node.js, saying which it is and what mn needs', () => {
    for (const node of ['20.10.0', '21.7.3', '18.20.8']) {
      expect(() => assertNodeSupported({ node })).toThrow(UnsupportedNodeError);
      expect(() => assertNodeSupported({ node })).toThrow(`midnight-wallet-cli needs Node.js 22 or newer; this is Node.js ${node}.`);
    }
  });

  it('refuses a version it can\'t read', () => {
    expect(() => assertNodeSupported({ node: 'unknown' })).toThrow(UnsupportedNodeError);
  });

  it('checks nothing under Bun, which reports the Node.js it is compatible with', () => {
    expect(() => assertNodeSupported({ node: '20.0.0', bun: '1.3.14' })).not.toThrow();
  });

  it('is UNSUPPORTED_NODE, exit code 1, for --json and MCP callers', () => {
    expect(classifyError(new UnsupportedNodeError('20.10.0'))).toEqual({ exitCode: 1, errorCode: 'UNSUPPORTED_NODE' });
  });

  it('accepts the Node.js these tests run on', () => {
    expect(() => assertNodeSupported()).not.toThrow();
  });
});
