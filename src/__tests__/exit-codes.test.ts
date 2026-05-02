import { describe, it, expect } from 'vitest';
import { classifyError, humanizeNetworkError, ERROR_CODES, EXIT_NETWORK_ERROR } from '../lib/exit-codes.ts';

describe('humanizeNetworkError', () => {
  it('rewrites the empty-reason node-fetch tail with URL + cause hint', () => {
    const original = 'request to http://localhost:8088/api/v3/graphql failed, reason:';
    const out = humanizeNetworkError(original);
    expect(out).toContain('http://localhost:8088/api/v3/graphql');
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
    const err = new Error('request to http://localhost:8088/api/v3/graphql failed, reason:');
    const { exitCode, errorCode } = classifyError(err);
    expect(exitCode).toBe(EXIT_NETWORK_ERROR);
    expect(errorCode).toBe(ERROR_CODES.NETWORK_ERROR);
  });
});
