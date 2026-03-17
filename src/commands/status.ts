// status command — show Midnight network health
// Usage: midnight status [--network <name>] [--all] [--json] [--watch]
//
// Runs local Tier 1 probes (real-time from your network) and overlays
// canary data from the dashboard (hourly monitoring history).
// No wallet or SDK needed — works from anywhere.

import { type ParsedArgs, getFlag, hasFlag } from '../lib/argv.ts';
import { DASHBOARD_BASE_URL } from '../lib/constants.ts';
import { getNetworkConfig, isValidNetworkName, type NetworkName } from '../lib/network.ts';
import { header, divider } from '../ui/format.ts';
import { bold, dim, teal, green, red, gray } from '../ui/colors.ts';
import { start as startSpinner } from '../ui/spinner.ts';
import { writeJsonResult } from '../lib/json-output.ts';

// ── Types matching status.json contract ──

type ServiceStatus = 'up' | 'down' | 'degraded' | 'unknown';

interface ProbeResult {
  status: ServiceStatus;
  latencyMs: number;
  lastChecked: string;
  notes?: string;
  peers?: number;
  isSyncing?: boolean;
  blockHeight?: number;
}

interface StatusJson {
  lastUpdated: string | null;
  networks: Record<string, Record<string, ProbeResult>>;
}

interface Issue {
  id: string;
  summary: string;
  affects: string;
  component: string;
  status: string;
}

interface IssuesJson {
  lastUpdated: string;
  issues: Issue[];
}

// ── Response types for external API calls ──

interface IndexerBlockResponse {
  data?: {
    block?: {
      height?: number;
    };
  };
}

interface SystemHealthResponse {
  result?: {
    peers: number;
    isSyncing: boolean;
    shouldHavePeers: boolean;
  };
}

// ── Faucet/explorer URLs (not in network.ts — only used for status probes) ──

const EXTRA_ENDPOINTS: Record<string, { faucet: string; explorer: string | null }> = {
  preprod: {
    faucet: 'https://faucet.preprod.midnight.network/',
    explorer: 'https://preprod.midnightexplorer.com/',
  },
  preview: {
    faucet: 'https://faucet.preview.midnight.network/',
    explorer: null,
  },
  undeployed: {
    faucet: '',
    explorer: '',
  },
};

// ── Service display config ──

const SERVICE_LABELS: Record<string, string> = {
  indexer: 'Indexer',
  rpc: 'RPC Node',
  faucet: 'Faucet',
  explorer: 'Explorer',
  chain: 'Chain',
  dust: 'Dust Generation',
  wallet: 'Wallet Ops',
  dapp: 'DApp Flow',
};

const STATUS_ICONS: Record<string, string> = {
  up: green('UP'),
  down: red('DOWN'),
  degraded: bold('\x1b[33mDEGRADED\x1b[0m'),
  unknown: dim('—'),
};

const PROBE_TIMEOUT_MS = 15_000;
const DEGRADED_THRESHOLD_MS = 5_000;
const FAUCET_DEGRADED_THRESHOLD_MS = 10_000;

// ── Helpers ──

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return `${Math.floor(diffMs / 86_400_000)}d ago`;
}

function overallStatus(services: Record<string, ProbeResult>): 'up' | 'degraded' | 'down' {
  let hasDown = false;
  let hasDegraded = false;
  for (const result of Object.values(services)) {
    if (result.status === 'down') hasDown = true;
    if (result.status === 'degraded') hasDegraded = true;
  }
  if (hasDown) return 'down';
  if (hasDegraded) return 'degraded';
  return 'up';
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${DASHBOARD_BASE_URL}${path}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`Dashboard returned HTTP ${response.status} for ${path}`);
  }
  return response.json() as Promise<T>;
}

async function tryDetectNetwork(args: ParsedArgs): Promise<string | undefined> {
  const flagNetwork = getFlag(args, 'network');
  if (flagNetwork) return flagNetwork;

  try {
    const { loadWalletConfig, resolveWalletPath } = await import('../lib/wallet-config.ts');
    const config = loadWalletConfig(resolveWalletPath(getFlag(args, 'wallet')));
    return config.network;
  } catch {
    return undefined;
  }
}

// ── Local Tier 1 probes ──

async function timedFetch(
  url: string,
  options: RequestInit = {},
): Promise<{ response: Response; latencyMs: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return { response, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeIndexer(indexerUrl: string): Promise<ProbeResult> {
  const now = new Date().toISOString();
  try {
    const { response, latencyMs } = await timedFetch(indexerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    if (!response.ok) {
      if (response.status === 403) return { status: 'degraded', latencyMs, lastChecked: now, notes: 'HTTP 403 — likely WAF blocking' };
      return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    }
    const body = await response.json() as IndexerBlockResponse;
    if (!body?.data) return { status: 'down', latencyMs, lastChecked: now, notes: 'No data field' };
    const blockHeight = body.data?.block?.height;
    return {
      status: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(blockHeight !== undefined ? { blockHeight } : {}),
      ...(latencyMs > DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeRpc(nodeUrl: string): Promise<ProbeResult> {
  const now = new Date().toISOString();
  // Convert wss:// to https:// for HTTP POST
  const httpUrl = nodeUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
  try {
    const { response, latencyMs } = await timedFetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
    });
    if (!response.ok) {
      if (response.status === 403) return { status: 'degraded', latencyMs, lastChecked: now, notes: 'HTTP 403 — likely WAF blocking' };
      return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    }
    const body = await response.json() as SystemHealthResponse;
    const result = body?.result;
    if (!result) return { status: 'down', latencyMs, lastChecked: now, notes: 'No result in response' };
    const peers = result.peers ?? 0;
    const isSyncing = result.isSyncing ?? false;
    let status: ServiceStatus = 'up';
    let notes: string | undefined;
    if (isSyncing) { status = 'degraded'; notes = 'Node is syncing'; }
    else if (peers === 0) { status = 'degraded'; notes = 'No peers'; }
    return { status, latencyMs, lastChecked: now, peers, isSyncing, ...(notes ? { notes } : {}) };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeFaucet(faucetUrl: string): Promise<ProbeResult> {
  const now = new Date().toISOString();
  if (!faucetUrl) return { status: 'unknown', latencyMs: 0, lastChecked: now, notes: 'No faucet URL' };
  try {
    const { response, latencyMs } = await timedFetch(faucetUrl);
    if (!response.ok) return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    return {
      status: latencyMs > FAUCET_DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(latencyMs > FAUCET_DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function probeExplorer(explorerUrl: string | null): Promise<ProbeResult> {
  const now = new Date().toISOString();
  if (!explorerUrl) return { status: 'unknown', latencyMs: 0, lastChecked: now, notes: 'URL not configured' };
  try {
    const { response, latencyMs } = await timedFetch(explorerUrl);
    if (!response.ok) return { status: 'down', latencyMs, lastChecked: now, notes: `HTTP ${response.status}` };
    const body = await response.text();
    if (!body || body.length === 0) return { status: 'down', latencyMs, lastChecked: now, notes: 'Empty response' };
    return {
      status: latencyMs > DEGRADED_THRESHOLD_MS ? 'degraded' : 'up',
      latencyMs,
      lastChecked: now,
      ...(latencyMs > DEGRADED_THRESHOLD_MS ? { notes: `Slow (${latencyMs}ms)` } : {}),
    };
  } catch (err) {
    return { status: 'down', latencyMs: 0, lastChecked: now, notes: (err as Error).message };
  }
}

async function runLocalProbes(networkName: string): Promise<Record<string, ProbeResult>> {
  if (!isValidNetworkName(networkName)) return {};

  const netConfig = getNetworkConfig(networkName as NetworkName);
  const extra = EXTRA_ENDPOINTS[networkName];
  if (!extra) return {};

  const [indexer, rpc, faucet, explorer] = await Promise.all([
    probeIndexer(netConfig.indexer),
    probeRpc(netConfig.node),
    probeFaucet(extra.faucet),
    probeExplorer(extra.explorer),
  ]);

  return { indexer, rpc, faucet, explorer };
}

// ── Render functions ──

function renderHealthTable(
  networkName: string,
  canaryServices: Record<string, ProbeResult> | undefined,
  liveServices: Record<string, ProbeResult>,
): void {
  process.stderr.write('\n  ' + bold(networkName) + '\n');
  process.stderr.write(dim('  ' + '─'.repeat(62)) + '\n');

  // Merge: show live probes first, then canary-only services (chain, dust, wallet, dapp)
  const allServices = new Set([
    ...Object.keys(liveServices),
    ...(canaryServices ? Object.keys(canaryServices) : []),
  ]);

  for (const service of allServices) {
    const live = liveServices[service];
    const canary = canaryServices?.[service];

    const label = (SERVICE_LABELS[service] ?? service).padEnd(18);

    if (live) {
      // Show live result
      const icon = STATUS_ICONS[live.status] ?? dim('—');
      const latency = live.latencyMs > 0 ? dim(` ${live.latencyMs}ms`) : '';
      const notes = live.notes ? dim(` — ${live.notes}`) : '';

      // If canary has a different status, show it as context
      let canaryNote = '';
      if (canary && canary.status !== live.status && canary.status !== 'unknown') {
        canaryNote = dim(` (canary: ${canary.status}${canary.lastChecked ? ' ' + formatAge(canary.lastChecked) : ''})`);
      }

      process.stderr.write(`  ${gray(label)}${icon}${latency}${notes}${canaryNote}\n`);
    } else if (canary) {
      // Canary-only service (chain, dust, wallet, dapp)
      const icon = STATUS_ICONS[canary.status] ?? dim('—');
      const latency = canary.latencyMs > 0 ? dim(` ${canary.latencyMs}ms`) : '';
      const checked = canary.lastChecked ? dim(` (${formatAge(canary.lastChecked)})`) : '';
      const notes = canary.notes ? dim(` — ${canary.notes}`) : '';

      process.stderr.write(`  ${gray(label)}${icon}${latency}${checked}${notes}\n`);
    }
  }
}

function renderIssues(issues: Issue[], networkFilter?: string): void {
  const filtered = networkFilter
    ? issues.filter(i => i.affects.toLowerCase().includes(networkFilter.toLowerCase()))
    : issues;

  if (filtered.length === 0) return;

  process.stderr.write('\n' + header('Known Issues') + '\n\n');
  for (const issue of filtered) {
    process.stderr.write(`  ${red(issue.id.padEnd(28))}${issue.summary}\n`);
    process.stderr.write(`  ${' '.repeat(28)}${dim(issue.status)}\n`);
  }
}

// ── Command ──

export default async function statusCommand(args: ParsedArgs): Promise<void> {
  const jsonMode = hasFlag(args, 'json');
  const showAll = hasFlag(args, 'all');
  const watchMode = hasFlag(args, 'watch');

  // Determine target network(s) first
  const detected = (await tryDetectNetwork(args)) ?? 'preprod';

  // Fetch canary data + run local probes in parallel
  const spinner = startSpinner('Checking network status...');

  let status: StatusJson | null = null;
  let issues: IssuesJson | null = null;
  let canaryError: string | undefined;

  // Determine networks for local probes
  let targetNetworks: string[];
  if (showAll) {
    targetNetworks = ['preprod', 'preview'];
  } else {
    targetNetworks = [detected];
  }

  // Run everything in parallel: canary fetch + local probes
  const [canaryResult, ...liveResults] = await Promise.all([
    // Canary data (best-effort)
    Promise.all([
      fetchJson<StatusJson>('/api/status'),
      fetchJson<IssuesJson>('/api/issues'),
    ]).catch((err) => {
      canaryError = (err as Error).message;
      return null;
    }),
    // Local probes per network
    ...targetNetworks.map(name => runLocalProbes(name)),
  ]);

  if (canaryResult) {
    [status, issues] = canaryResult;
  }

  spinner.stop('Done');

  // Build live results map
  const liveByNetwork: Record<string, Record<string, ProbeResult>> = {};
  for (let i = 0; i < targetNetworks.length; i++) {
    liveByNetwork[targetNetworks[i]] = liveResults[i] as Record<string, ProbeResult>;
  }

  // JSON mode
  if (jsonMode) {
    const result: Record<string, unknown> = {
      lastUpdated: status?.lastUpdated ?? null,
      dashboard: DASHBOARD_BASE_URL,
      canaryAvailable: status !== null,
      networks: {} as Record<string, unknown>,
    };

    for (const name of targetNetworks) {
      const live = liveByNetwork[name] ?? {};
      const canary = status?.networks[name];
      // Merge: live probes + canary-only services
      const merged = { ...canary, ...live };
      (result.networks as Record<string, unknown>)[name] = {
        overall: overallStatus(merged),
        live,
        canary: canary ?? null,
      };
    }

    if (issues) {
      const networkFilter = showAll ? undefined : targetNetworks[0];
      result.issues = networkFilter
        ? issues.issues.filter(i => i.affects.toLowerCase().includes(networkFilter.toLowerCase()))
        : issues.issues;
    }

    if (canaryError) result.canaryError = canaryError;

    writeJsonResult(result);

    const worstStatus = targetNetworks.reduce((worst, name) => {
      const merged = { ...(status?.networks[name] ?? {}), ...(liveByNetwork[name] ?? {}) };
      const s = overallStatus(merged);
      if (s === 'down') return 'down';
      if (s === 'degraded' && worst !== 'down') return 'degraded';
      return worst;
    }, 'up' as string);

    if (worstStatus === 'down') process.exitCode = 2;
    else if (worstStatus === 'degraded') process.exitCode = 1;
    return;
  }

  // ── Render ──

  const renderOnce = () => {
    process.stderr.write('\n' + header('Midnight Network Status') + '\n');

    if (status?.lastUpdated) {
      process.stderr.write(dim(`  Canary: ${formatAge(status.lastUpdated)}`) + '  ');
    }
    process.stderr.write(dim(`Live: just now`) + '\n');

    if (canaryError) {
      process.stderr.write(dim(`  (Dashboard unreachable: ${canaryError})`) + '\n');
    }

    if (targetNetworks.length === 0) {
      process.stderr.write('\n  ' + dim('No network data available.') + '\n\n');
      return;
    }

    // Health tables — live + canary overlay
    for (const name of targetNetworks) {
      renderHealthTable(name, status?.networks[name], liveByNetwork[name] ?? {});
    }

    // Known issues
    if (issues) {
      const networkFilter = showAll ? undefined : targetNetworks[0];
      renderIssues(issues.issues, networkFilter);
    }

    // Dashboard link
    process.stderr.write('\n' + divider() + '\n');
    process.stderr.write(dim('  Dashboard: ') + teal(DASHBOARD_BASE_URL) + '\n\n');
  };

  renderOnce();

  // Watch mode: re-probe every 30s
  if (watchMode) {
    const interval = setInterval(async () => {
      try {
        // Re-fetch canary + re-run live probes
        const [newCanary, ...newLive] = await Promise.all([
          Promise.all([
            fetchJson<StatusJson>('/api/status'),
            fetchJson<IssuesJson>('/api/issues'),
          ]).catch(() => null),
          ...targetNetworks.map(name => runLocalProbes(name)),
        ]);

        if (newCanary) [status, issues] = newCanary;
        for (let i = 0; i < targetNetworks.length; i++) {
          liveByNetwork[targetNetworks[i]] = newLive[i] as Record<string, ProbeResult>;
        }

        process.stderr.write('\x1b[2J\x1b[H');
        renderOnce();
      } catch {
        process.stderr.write(dim(`  Refresh failed — retrying in 30s`) + '\n');
      }
    }, 30_000);

    await new Promise<void>(() => {
      process.on('SIGINT', () => {
        clearInterval(interval);
        process.exit(0);
      });
    });
  }

  // Exit code
  const worstStatus = targetNetworks.reduce((worst, name) => {
    const merged = { ...(status?.networks[name] ?? {}), ...(liveByNetwork[name] ?? {}) };
    const s = overallStatus(merged);
    if (s === 'down') return 'down';
    if (s === 'degraded' && worst !== 'down') return 'degraded';
    return worst;
  }, 'up' as string);

  if (worstStatus === 'down') process.exitCode = 2;
  else if (worstStatus === 'degraded') process.exitCode = 1;
}
