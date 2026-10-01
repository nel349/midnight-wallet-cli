// Ledger guard: a ledger-8 chain must be refused up front with a clear
// message. Protocol versions are the ones observed live on 2026-10-01:
// preview 1000300 (ledger 8), ledger-9 localnet 2001000.

import { describe, it, expect, vi } from 'vitest';
import {
  checkLedgerSupported,
  assertLedgerSupported,
  UnsupportedLedgerError,
} from '../lib/ledger-guard.ts';
import type { NetworkConfig } from '../lib/network.ts';

const PREVIEW = 1000300n;
const LEDGER9_LOCALNET = 2001000n;

describe('checkLedgerSupported', () => {
  it('refuses a ledger-8 chain, naming the network, its version, and what to use instead', () => {
    let err: unknown;
    try { checkLedgerSupported('preview', PREVIEW); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedLedgerError);
    expect((err as UnsupportedLedgerError).code).toBe('UNSUPPORTED_LEDGER');
    expect((err as Error).message).toContain('preview is on ledger 8 (protocol version 1000300)');
    expect((err as Error).message).toContain('midnight-wallet-cli 0.5.x');
  });

  it('accepts a ledger-9 chain', () => {
    expect(() => checkLedgerSupported('undeployed', LEDGER9_LOCALNET)).not.toThrow();
  });

  it('accepts exactly the fork version, the first ledger-9 version', () => {
    expect(() => checkLedgerSupported('undeployed', 2000000n)).not.toThrow();
    expect(() => checkLedgerSupported('undeployed', 1999999n)).toThrow(UnsupportedLedgerError);
  });

  it('lets an unknown version through, so the real network error surfaces instead', () => {
    expect(() => checkLedgerSupported('preprod', null)).not.toThrow();
  });
});

describe('assertLedgerSupported', () => {
  const network = { indexer: 'http://indexer.example/api/v4/graphql' } as NetworkConfig;

  it('probes the network\'s indexer HTTP endpoint and refuses a ledger-8 answer', async () => {
    const fetchVersion = vi.fn().mockResolvedValue(PREVIEW);
    await expect(assertLedgerSupported('preview', network, fetchVersion)).rejects.toBeInstanceOf(UnsupportedLedgerError);
    expect(fetchVersion).toHaveBeenCalledWith('http://indexer.example/api/v4/graphql');
  });

  it('resolves for a ledger-9 answer', async () => {
    await expect(assertLedgerSupported('undeployed', network, async () => LEDGER9_LOCALNET)).resolves.toBeUndefined();
  });
});
