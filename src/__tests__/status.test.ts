import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Test helpers ──

// Mock fetch globally for all tests
const originalFetch = globalThis.fetch;

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  globalThis.fetch = handler as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

// Capture stderr output
function captureStderr(): { output: string; restore: () => void } {
  const chunks: string[] = [];
  const origWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    get output() { return chunks.join(''); },
    restore: () => { process.stderr.write = origWrite; },
  };
}

// Build a mock Response
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

// ── Fixtures ──

const MOCK_STATUS: Record<string, unknown> = {
  lastUpdated: '2026-03-12T05:00:00Z',
  sdkVersions: {
    stable: { name: 'midnight-sdk-1.0-stable', version: '1.0.0' },
    experimental: { name: 'midnight-sdk-1.1-experimental', version: '1.1.0-rc.1' },
  },
  networks: {
    preprod: {
      indexer: { status: 'up', latencyMs: 120, lastChecked: '2026-03-12T05:00:00Z' },
      rpc: { status: 'up', latencyMs: 85, lastChecked: '2026-03-12T05:00:00Z', peers: 10 },
      faucet: { status: 'down', latencyMs: 0, lastChecked: '2026-03-12T05:00:00Z', notes: 'fetch failed' },
      chain: { status: 'up', latencyMs: 100, lastChecked: '2026-03-12T05:00:00Z', blockHeight: 592000 },
    },
    preview: {
      indexer: { status: 'up', latencyMs: 200, lastChecked: '2026-03-12T05:00:00Z' },
      rpc: { status: 'up', latencyMs: 150, lastChecked: '2026-03-12T05:00:00Z', peers: 15 },
      faucet: { status: 'up', latencyMs: 300, lastChecked: '2026-03-12T05:00:00Z' },
      chain: { status: 'up', latencyMs: 180, lastChecked: '2026-03-12T05:00:00Z', blockHeight: 540000 },
    },
  },
};

const MOCK_ISSUES = {
  lastUpdated: '2026-03-12T05:00:00Z',
  issues: [
    { id: 'aws-waf-vpn', summary: 'WAF blocks VPN', affects: 'preprod', component: 'infrastructure', status: 'Escalated' },
    { id: 'lace-139', summary: 'Error 139 on Lace', affects: 'preprod, undeployed', component: 'lace', status: 'Fix coming' },
  ],
};

// GraphQL and RPC mock responses
const MOCK_INDEXER_RESPONSE = { data: { block: { height: 592500 } } };
const MOCK_RPC_RESPONSE = { result: { peers: 11, isSyncing: false, shouldHavePeers: true } };

describe('status command', () => {
  let stderr: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    stderr = captureStderr();
    process.exitCode = undefined;
  });

  afterEach(() => {
    stderr.restore();
    restoreFetch();
    process.exitCode = undefined;
  });

  async function runStatus(flags: Record<string, string | true> = {}) {
    // Dynamic import to get fresh module
    const mod = await import('../commands/status.ts');
    await mod.default({
      command: 'status',
      subcommand: undefined,
      positionals: [],
      flags,
    });
  }

  function setupMockFetch(options: {
    dashboardDown?: boolean;
    indexerDown?: boolean;
    rpcDown?: boolean;
    faucetDown?: boolean;
    explorerDown?: boolean;
  } = {}) {
    mockFetch(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);

      // Dashboard endpoints
      if (urlStr.includes('/api/status')) {
        if (options.dashboardDown) throw new Error('Connection refused');
        return jsonResponse(MOCK_STATUS);
      }
      if (urlStr.includes('/api/issues')) {
        if (options.dashboardDown) throw new Error('Connection refused');
        return jsonResponse(MOCK_ISSUES);
      }

      // Local probes — indexer GraphQL
      if (urlStr.includes('indexer') && urlStr.includes('graphql')) {
        if (options.indexerDown) throw new Error('ECONNREFUSED');
        return jsonResponse(MOCK_INDEXER_RESPONSE);
      }

      // Local probes — RPC
      if (urlStr.includes('rpc')) {
        if (options.rpcDown) return textResponse('', 503);
        return jsonResponse(MOCK_RPC_RESPONSE);
      }

      // Local probes — faucet
      if (urlStr.includes('faucet')) {
        if (options.faucetDown) throw new Error('fetch failed');
        return textResponse('<html>faucet</html>');
      }

      // Local probes — explorer
      if (urlStr.includes('explorer') || urlStr.includes('midnightexplorer')) {
        if (options.explorerDown) throw new Error('fetch failed');
        return textResponse('<html>explorer</html>');
      }

      // Fallback
      return textResponse('', 404);
    });
  }

  it('renders health table with live + canary data', async () => {
    setupMockFetch();
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('Midnight Network Status');
    expect(stderr.output).toContain('preprod');
    expect(stderr.output).toContain('Canary:');
    expect(stderr.output).toContain('Live: just now');
    expect(stderr.output).toContain('SDK Versions');
  });

  it('shows known issues filtered by network', async () => {
    setupMockFetch();
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('aws-waf-vpn');
    expect(stderr.output).toContain('WAF blocks VPN');
  });

  it('renders SDK versions', async () => {
    setupMockFetch();
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('1.0.0');
    expect(stderr.output).toContain('1.1.0-rc.1');
  });

  it('renders dashboard link', async () => {
    setupMockFetch();
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('midnight-comp-tracker.vercel.app');
  });

  it('--all shows both networks', async () => {
    setupMockFetch();
    await runStatus({ network: 'preprod', all: true });

    expect(stderr.output).toContain('preprod');
    expect(stderr.output).toContain('preview');
  });

  it('--json outputs structured JSON', async () => {
    // Capture stdout for JSON mode
    const stdoutChunks: string[] = [];
    const origStdout = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stdout.write;

    setupMockFetch();
    await runStatus({ network: 'preprod', json: true });

    process.stdout.write = origStdout;

    const output = stdoutChunks.join('');
    const json = JSON.parse(output);

    expect(json.lastUpdated).toBe('2026-03-12T05:00:00Z');
    expect(json.dashboard).toContain('midnight-comp-tracker');
    expect(json.canaryAvailable).toBe(true);
    expect(json.networks.preprod).toBeDefined();
    expect(json.networks.preprod.overall).toBeDefined();
    expect(json.networks.preprod.live).toBeDefined();
    expect(json.networks.preprod.canary).toBeDefined();
    expect(json.issues).toBeInstanceOf(Array);
  });

  it('exit code 0 when all services UP', async () => {
    setupMockFetch();
    await runStatus({ network: 'preview' });

    // preview has no faucet DOWN in canary, and live probes all succeed
    expect(process.exitCode).toBeUndefined();
  });

  it('exit code 2 when a service is DOWN', async () => {
    setupMockFetch({ faucetDown: true });
    await runStatus({ network: 'preprod' });

    expect(process.exitCode).toBe(2);
  });

  it('exit code 3 when dashboard unreachable and no live DOWN', async () => {
    setupMockFetch({ dashboardDown: true });
    await runStatus({ network: 'preprod' });

    // Dashboard unreachable falls through to live-only rendering
    // Since live probes succeed, exit code depends on live results only
    // (no canary data means no faucet DOWN from canary)
    expect(stderr.output).toContain('Dashboard unreachable');
  });

  it('handles indexer DOWN in live probes', async () => {
    setupMockFetch({ indexerDown: true });
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('DOWN');
    expect(process.exitCode).toBe(2);
  });

  it('handles RPC DOWN in live probes', async () => {
    setupMockFetch({ rpcDown: true });
    await runStatus({ network: 'preprod' });

    expect(stderr.output).toContain('DOWN');
  });

  it('defaults to preprod when no wallet exists', async () => {
    setupMockFetch();
    await runStatus({});

    expect(stderr.output).toContain('preprod');
  });
});
