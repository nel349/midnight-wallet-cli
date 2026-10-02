// Local stack auto-detection on `undeployed`. With one local Midnight stack
// running, mn finds its ports. With several, it used to keep whichever
// container `docker ps` listed last, which could send a command to a
// different chain than intended. Now it refuses unless endpoints are given
// explicitly. The docker output below is real output from a machine running
// two stacks (image names normalised).

import { describe, it, expect } from 'vitest';
import {
  parseLocalStacks,
  pickLocalStack,
  resolveNetworkConfig,
  AmbiguousLocalStacksError,
} from '../lib/network.ts';

const SCRATCH = [
  'midnightntwrk/indexer-standalone:4.4.0-rc.5|0.0.0.0:28088->8088/tcp, [::]:28088->8088/tcp',
  'midnightntwrk/midnight-node:2.1.0-rc.2|0.0.0.0:29944->9944/tcp, [::]:29944->9944/tcp',
  'midnightntwrk/proof-server:9.0.0-rc.8|0.0.0.0:26300->6300/tcp, [::]:26300->6300/tcp',
];
const BENCH = [
  'midnightntwrk/indexer-standalone:4.4.0-rc.5|0.0.0.0:8088->8088/tcp, [::]:8088->8088/tcp',
  'midnightntwrk/midnight-node:2.1.0-rc.2|0.0.0.0:9944->9944/tcp, [::]:9944->9944/tcp',
  'midnightntwrk/proof-server:9.0.0-rc.8|0.0.0.0:6300->6300/tcp, [::]:6300->6300/tcp',
];
const ps = (...lines: string[][]) => lines.flat().join('\n') + '\n';

describe('parseLocalStacks', () => {
  it('collects each component\'s distinct host ports (IPv4 and IPv6 bindings count once)', () => {
    expect(parseLocalStacks(ps(SCRATCH, BENCH))).toEqual({
      node: [9944, 29944],
      indexer: [8088, 28088],
      proofServer: [6300, 26300],
    });
  });

  it('ignores unrelated containers', () => {
    expect(parseLocalStacks('postgres:16|0.0.0.0:5432->5432/tcp\n')).toEqual({ node: [], indexer: [], proofServer: [] });
  });
});

describe('pickLocalStack', () => {
  it('returns the ports of a single running stack', () => {
    expect(pickLocalStack(parseLocalStacks(ps(SCRATCH)))).toEqual({ nodePort: 29944, indexerPort: 28088, proofServerPort: 26300 });
  });

  it('returns nothing when no stack runs', () => {
    expect(pickLocalStack(parseLocalStacks(''))).toEqual({});
  });

  it('refuses to choose between two stacks, listing every port it found and how to choose', () => {
    let err: unknown;
    try { pickLocalStack(parseLocalStacks(ps(SCRATCH, BENCH))); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AmbiguousLocalStacksError);
    const msg = (err as Error).message;
    expect(msg).toContain('node 9944, 29944');
    expect(msg).toContain('indexer 8088, 28088');
    expect(msg).toContain('--node');
    expect(msg).toContain('midnight config set');
  });

  it('refuses when even one component is ambiguous (it would mix two stacks)', () => {
    expect(() => pickLocalStack(parseLocalStacks(ps(SCRATCH, [BENCH[0]!]))))
      .toThrow(AmbiguousLocalStacksError);
  });
});

describe('resolveNetworkConfig on undeployed', () => {
  const twoStacks = () => parseLocalStacks(ps(SCRATCH, BENCH));

  it('refuses when several stacks run and no endpoints were given', () => {
    expect(() => resolveNetworkConfig('undeployed', { detect: twoStacks })).toThrow(AmbiguousLocalStacksError);
  });

  it('does not detect at all when endpoints are explicit, so several stacks are fine', () => {
    let detected = false;
    const cfg = resolveNetworkConfig('undeployed', { explicitEndpoints: true, detect: () => { detected = true; return twoStacks(); } });
    expect(detected).toBe(false);
    expect(cfg.node).toBe('ws://localhost:9944'); // the default, which the caller's overrides then replace
  });

  it('uses the single detected stack', () => {
    const cfg = resolveNetworkConfig('undeployed', { detect: () => parseLocalStacks(ps(SCRATCH)) });
    expect(cfg.node).toBe('ws://localhost:29944');
    expect(cfg.indexerWS).toBe('ws://localhost:28088/api/v4/graphql/ws');
    expect(cfg.proofServer).toBe('http://localhost:26300');
  });

  it('never detects for hosted networks', () => {
    let detected = false;
    resolveNetworkConfig('preprod', { detect: () => { detected = true; return twoStacks(); } });
    expect(detected).toBe(false);
  });
});

describe('resolveNetwork', () => {
  it('skips local detection when an endpoint flag is given, so it works with any number of stacks', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { resolveNetwork } = await import('../lib/resolve-network.ts');
    const { parseArgs } = await import('../lib/argv.ts');
    const configDir = mkdtempSync(join(tmpdir(), 'mn-resolve-')); // empty config: no saved endpoints
    try {
      const { name, config } = resolveNetwork({
        args: parseArgs(['balance', '--network', 'undeployed', '--node', 'ws://localhost:29944']),
        configDir,
      });
      expect(name).toBe('undeployed');
      // Defaults, untouched by detection; the command's applyEndpointOverrides sets the flag's URL next.
      expect(config.node).toBe('ws://localhost:9944');
      expect(config.indexer).toBe('http://localhost:8088/api/v4/graphql');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
