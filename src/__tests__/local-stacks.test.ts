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

  it('does not detect at all when every endpoint is given, so several stacks are fine', () => {
    let detected = false;
    const cfg = resolveNetworkConfig('undeployed', {
      given: { node: 'ws://localhost:29944', indexerWS: 'ws://localhost:28088/api/v4/graphql/ws', proofServer: 'http://localhost:26300' },
      detect: () => { detected = true; return twoStacks(); },
    });
    expect(detected).toBe(false);
    expect(cfg.node).toBe('ws://localhost:29944');
    expect(cfg.indexerWS).toBe('ws://localhost:28088/api/v4/graphql/ws');
    expect(cfg.indexer).toBe('http://localhost:28088/api/v4/graphql');
    expect(cfg.proofServer).toBe('http://localhost:26300');
  });

  it('detects only the components not given (one stack, only --proof-server given)', () => {
    const cfg = resolveNetworkConfig('undeployed', {
      given: { proofServer: 'http://localhost:6301' },
      detect: () => parseLocalStacks(ps(SCRATCH)),
    });
    expect(cfg.proofServer).toBe('http://localhost:6301');
    expect(cfg.node).toBe('ws://localhost:29944');
    expect(cfg.indexerWS).toBe('ws://localhost:28088/api/v4/graphql/ws');
  });

  it('refuses when a component it must detect is ambiguous, even if others are given', () => {
    expect(() => resolveNetworkConfig('undeployed', {
      given: { proofServer: 'http://localhost:26300' },
      detect: twoStacks,
    })).toThrow(AmbiguousLocalStacksError);
  });

  it('does not refuse over an ambiguous component that was given', () => {
    // Two proof servers run, but the proof server is given; node and indexer have one stack each.
    const cfg = resolveNetworkConfig('undeployed', {
      given: { proofServer: 'http://localhost:26300' },
      detect: () => parseLocalStacks(ps(SCRATCH, [BENCH[2]!])),
    });
    expect(cfg.node).toBe('ws://localhost:29944');
    expect(cfg.proofServer).toBe('http://localhost:26300');
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
  // A temp config dir per test: the real ~/.midnight config must not leak in.
  async function withConfig(config: object | null, fn: (configDir: string) => Promise<void> | void): Promise<void> {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const configDir = mkdtempSync(join(tmpdir(), 'mn-resolve-'));
    try {
      if (config) writeFileSync(join(configDir, 'config.json'), JSON.stringify(config));
      await fn(configDir);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  }

  it('applies endpoints saved with `midnight config set`, for commands with no endpoint flags', async () => {
    const { resolveNetwork } = await import('../lib/resolve-network.ts');
    const { parseArgs } = await import('../lib/argv.ts');
    await withConfig({
      network: 'undeployed',
      networks: { undeployed: { node: 'ws://localhost:29944', 'indexer-ws': 'ws://localhost:28088/api/v4/graphql/ws', 'proof-server': 'http://localhost:26300' } },
    }, (configDir) => {
      const { config } = resolveNetwork({ args: parseArgs(['test']), configDir });
      expect(config.node).toBe('ws://localhost:29944');
      expect(config.indexer).toBe('http://localhost:28088/api/v4/graphql');
      expect(config.indexerWS).toBe('ws://localhost:28088/api/v4/graphql/ws');
      expect(config.proofServer).toBe('http://localhost:26300');
    });
  });

  it('lets a flag win over the saved config', async () => {
    const { resolveNetwork } = await import('../lib/resolve-network.ts');
    const { parseArgs } = await import('../lib/argv.ts');
    await withConfig({ network: 'undeployed', networks: { undeployed: { node: 'ws://localhost:29944' } } }, (configDir) => {
      const { config } = resolveNetwork({ args: parseArgs(['balance', '--node', 'ws://localhost:39944']), configDir });
      expect(config.node).toBe('ws://localhost:39944');
    });
  });

  it('with every endpoint given by flag, works whatever docker runs', async () => {
    const { resolveNetwork } = await import('../lib/resolve-network.ts');
    const { parseArgs } = await import('../lib/argv.ts');
    await withConfig(null, (configDir) => {
      const { name, config } = resolveNetwork({
        args: parseArgs(['balance', '--network', 'undeployed', '--node', 'ws://localhost:29944',
          '--indexer-ws', 'ws://localhost:28088/api/v4/graphql/ws', '--proof-server', 'http://localhost:26300']),
        configDir,
      });
      expect(name).toBe('undeployed');
      expect(config.node).toBe('ws://localhost:29944');
      expect(config.indexer).toBe('http://localhost:28088/api/v4/graphql');
    });
  });
});

describe('mn cache clear with several local stacks', () => {
  it('needs only the network name, so it never runs detection', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('../commands/cache.ts', import.meta.url), 'utf-8');
    // Full resolution would detect local stacks and refuse when several run,
    // yet cache takes no endpoint flags to settle it.
    expect(src).toContain('resolveNetworkName(');
    expect(src).not.toMatch(/\bresolveNetwork\(/);
  });
});
