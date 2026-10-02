// Ledger guard: a ledger-8 chain must be refused up front with a clear
// message. Protocol versions are the ones observed live on 2026-10-01:
// preview 1000300 (ledger 8), ledger-9 localnet 2001000.

import { describe, it, expect, vi } from 'vitest';
import {
  checkLedgerSupported,
  assertLedgerSupported,
  assertLedger9StackReachable,
  fetchProtocolVersion,
  UnsupportedLedgerError,
  LocalStackUnreachableError,
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

describe('assertLedger9StackReachable', () => {
  const network = { indexer: 'http://localhost:28088/api/v4/graphql', node: 'ws://localhost:29944' } as NetworkConfig;
  const up = { fetchVersion: async () => LEDGER9_LOCALNET, fetchGenesis: async () => '0xabc' };

  it('passes when the indexer reports ledger 9 and the node answers', async () => {
    await expect(assertLedger9StackReachable('undeployed', network, up)).resolves.toBeUndefined();
  });

  it('refuses when the indexer does not answer, naming it and how to point mn at a stack', async () => {
    const err = await assertLedger9StackReachable('undeployed', network, { ...up, fetchVersion: async () => null }).catch((e) => e);
    expect(err).toBeInstanceOf(LocalStackUnreachableError);
    expect(err.message).toContain('indexer at http://localhost:28088/api/v4/graphql did not answer');
    expect(err.message).toContain('midnight config set');
  });

  it('refuses a ledger-8 stack with the ledger error, before probing the node', async () => {
    let nodeProbed = false;
    const err = await assertLedger9StackReachable('undeployed', network, {
      fetchVersion: async () => PREVIEW,
      fetchGenesis: async () => { nodeProbed = true; return '0xabc'; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedLedgerError);
    expect(nodeProbed).toBe(false);
  });

  it('refuses when the node does not answer', async () => {
    const err = await assertLedger9StackReachable('undeployed', network, { ...up, fetchGenesis: async () => null }).catch((e) => e);
    expect(err).toBeInstanceOf(LocalStackUnreachableError);
    expect(err.message).toContain('node at ws://localhost:29944 did not answer');
  });
});

describe('fetchProtocolVersion', () => {
  // A local HTTP server stands in for the indexer: real fetch, real parsing.
  async function withIndexer(body: string, fn: (url: string) => Promise<void>): Promise<void> {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(body); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as import('node:net').AddressInfo;
    try { await fn(`http://127.0.0.1:${port}/api/v4/graphql`); } finally { server.close(); }
  }

  it('reads the tip protocol version', async () => {
    await withIndexer('{"data":{"block":{"protocolVersion":2001000}}}', async (url) => {
      expect(await fetchProtocolVersion(url)).toBe(2001000n);
    });
  });

  it('returns null for a GraphQL error, a missing field, or a non-JSON answer', async () => {
    for (const body of ['{"errors":[{"message":"boom"}]}', '{"data":{"block":{}}}', 'not json']) {
      await withIndexer(body, async (url) => {
        expect(await fetchProtocolVersion(url), body).toBeNull();
      });
    }
  });

  it('returns null when nothing listens', async () => {
    expect(await fetchProtocolVersion('http://127.0.0.1:1/api/v4/graphql')).toBeNull();
  });
});
