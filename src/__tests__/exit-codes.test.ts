import { describe, it, expect } from 'vitest';
import { classifyError, humanizeNetworkError, ERROR_CODES, EXIT_NETWORK_ERROR, EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';

describe('humanizeNetworkError', () => {
  it('rewrites the empty-reason node-fetch tail with URL + cause hint', () => {
    const original = 'request to http://localhost:8088/api/v4/graphql failed, reason:';
    const out = humanizeNetworkError(original);
    expect(out).toContain('http://localhost:8088/api/v4/graphql');
    expect(out).toContain('connection refused');
    expect(out).toContain('Is the indexer running?');
    expect(out).not.toMatch(/reason:\s*$/);
  });

  it('leaves messages with a real reason untouched', () => {
    const original = 'request to https://api.example.com failed, reason: ECONNREFUSED 127.0.0.1:443';
    expect(humanizeNetworkError(original)).toBe(original);
  });

  it('leaves unrelated messages untouched', () => {
    expect(humanizeNetworkError('Wallet has 0 NIGHT')).toBe('Wallet has 0 NIGHT');
    expect(humanizeNetworkError('')).toBe('');
  });
});

describe('classifyError network coverage', () => {
  it('classifies the empty-reason node-fetch error as NETWORK_ERROR', () => {
    const err = new Error('request to http://localhost:8088/api/v4/graphql failed, reason:');
    const { exitCode, errorCode } = classifyError(err);
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.NETWORK_ERROR);
  });
});

describe('classifyError usage errors (positional-address balance)', () => {
  it('classifies the "shielded balances are private" error as INVALID_ARGS', () => {
    const err = new Error(
      'Shielded balances are private — they can only be read with the wallet\'s secret key, not from an address alone.\n' +
      'This address isn\'t one of your wallets. Check its shielded balance from the wallet that owns it:\n' +
      '  midnight balance --wallet <name> --shielded --network undeployed',
    );
    const { exitCode, errorCode } = classifyError(err);
    expect(exitCode).toBe(EXIT_INVALID_ARGS);
    expect(errorCode).toBe(ERROR_CODES.INVALID_ARGS);
  });

  it('classifies the address-HRP / --network mismatch as INVALID_ARGS', () => {
    const err = new Error('Address belongs to undeployed but --network is preprod.\nDrop --network or pass an address for preprod.');
    const { exitCode, errorCode } = classifyError(err);
    expect(exitCode).toBe(EXIT_INVALID_ARGS);
    expect(errorCode).toBe(ERROR_CODES.INVALID_ARGS);
  });
});
