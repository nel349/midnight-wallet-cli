// Localnet management — Docker Compose helpers for midnight-local-network
// Manages a compose.yml at ~/.midnight/localnet/ and shells out to docker compose

import { execSync, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { MIDNIGHT_DIR, LOCALNET_DIR_NAME, DIR_MODE } from './constants.ts';

// Version tag — bump when compose content changes so stale files get overwritten
export const COMPOSE_VERSION = '3.0.6';

// Docker image versions — update together per Midnight support matrix.
// Tracks the Preview/Preprod generation (the row our SDK stack targets:
// midnight-js 4.1.1, ledger-v8 8.x, compact-runtime 0.16.0), NOT the older
// Mainnet row (node 0.22.5). See https://docs.midnight.network/relnotes/support-matrix
const NODE_IMAGE = 'midnightntwrk/midnight-node:1.0.0';
const INDEXER_IMAGE = 'midnightntwrk/indexer-standalone:4.3.3';
const PROOF_SERVER_IMAGE = 'midnightntwrk/proof-server:8.1.0';

export const LOCALNET_DIR = join(homedir(), MIDNIGHT_DIR, LOCALNET_DIR_NAME);
const COMPOSE_PATH = join(LOCALNET_DIR, 'compose.yml');
const VERSION_PATH = join(LOCALNET_DIR, '.version');

// Full compose.yml for midnight-local-network — Preview/Preprod matrix generation
// (midnight-js 4.1.1 / ledger-v8 8.x / compact-runtime 0.16.0)
export const COMPOSE_YAML = `services:
  proof-server:
    image: '${PROOF_SERVER_IMAGE}'
    container_name: "proof-server"
    # Self-heal across Docker Desktop restarts and transient stops. Without this,
    # a stopped node/proof-server never comes back while the indexer (below) does,
    # leaving a half-dead localnet: the indexer answers but the node's ws is gone,
    # surfacing downstream as ws "Normal Closure" churn and a wedged dust sync.
    restart: unless-stopped
    ports:
      - "6300:6300"

  indexer:
    image: '${INDEXER_IMAGE}'
    container_name: "indexer"
    # unless-stopped covers two cases: (1) indexer >=4.3.x runs an SPO sub-indexer
    # that queries block #1 at startup and exits the whole process if it isn't there
    # yet — on a fresh chain the node hasn't minted block #1 in the first few seconds,
    # so the first launch loses this race and the restart lets the retry catch up once
    # the node mints block #1 (~6s block time); and (2) Docker Desktop restarts /
    # transient stops, so the whole localnet self-heals (see node + proof-server)
    # instead of going half-dead.
    restart: unless-stopped
    ports:
      - '8088:8088'
    environment:
      RUST_LOG: "indexer=info,chain_indexer=info,indexer_api=info,wallet_indexer=info,indexer_common=info,fastrace_opentelemetry=info,info"
      # Random 32-byte hex-encoded secret used to make the standalone indexer run.
      # Only needed to satisfy the config schema – not meant for secure use.
      APP__INFRA__SECRET: "303132333435363738393031323334353637383930313233343536373839303132"
      APP__INFRA__NODE__URL: "ws://node:9944"
      # indexer >=4.3.x added a separate SPO poller. Point it at our node
      # (defaults to localhost, which is the indexer container itself), and
      # satisfy the now-required blockfrost_id with a placeholder — SPO/staking
      # features aren't exercised on localnet, and any non-empty value loads.
      APP__INFRA__SPO_NODE__URL: "ws://node:9944"
      APP__INFRA__SPO_NODE__BLOCKFROST_ID: "dummy-not-using-spo"
    healthcheck:
      test: ["CMD-SHELL", "cat /var/run/indexer-standalone/running"]
      start_interval: "5s"
      interval: "5s"
      timeout: "2s"
      retries: 2
      start_period: 5s
    depends_on:
      node:
        condition: service_started

  node:
    image: '${NODE_IMAGE}'
    container_name: "node"
    # Self-heal across Docker Desktop restarts / transient stops (see proof-server).
    restart: unless-stopped
    ports:
      - "9944:9944"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:9944/health"]
      interval: 2s
      timeout: 5s
      retries: 5
      start_period: 5s
    environment:
      CFG_PRESET: "dev"
`;

const EXEC_OPTIONS: ExecSyncOptionsWithStringEncoding = {
  encoding: 'utf-8',
  timeout: 30_000,
};

/**
 * Check that `docker compose version` succeeds.
 * Returns the version string on success, or throws a descriptive error.
 */
export function checkDockerAvailable(): string {
  try {
    const output = execSync('docker compose version', { ...EXEC_OPTIONS, timeout: 10_000 });
    return output.trim();
  } catch {
    // Try plain docker first to distinguish "no docker" from "no compose v2"
    try {
      execSync('docker --version', { ...EXEC_OPTIONS, timeout: 5_000 });
      throw new Error(
        'Docker Compose v2 is required.\n' +
        'Install it from https://docs.docker.com/compose/install/'
      );
    } catch (innerErr) {
      if (innerErr instanceof Error && innerErr.message.includes('Docker Compose v2')) {
        throw innerErr;
      }
      throw new Error(
        'Docker is required but was not found.\n' +
        'Install Docker from https://docs.docker.com/get-docker/'
      );
    }
  }
}

/**
 * Write compose.yml to LOCALNET_DIR if it doesn't exist or the version has changed.
 * Returns true if the file was written, false if it was already up to date.
 */
export function ensureComposeFile(): boolean {
  const versionMatches =
    existsSync(VERSION_PATH) &&
    existsSync(COMPOSE_PATH) &&
    readFileSync(VERSION_PATH, 'utf-8').trim() === COMPOSE_VERSION;

  if (versionMatches) return false;

  mkdirSync(LOCALNET_DIR, { recursive: true, mode: DIR_MODE });
  writeFileSync(COMPOSE_PATH, COMPOSE_YAML, 'utf-8');
  writeFileSync(VERSION_PATH, COMPOSE_VERSION, 'utf-8');
  return true;
}

/**
 * Run `docker compose -f <path> <args>` and return stdout.
 * Throws on non-zero exit with stderr as the error message.
 */
export function dockerCompose(args: string): string {
  return execSync(
    `docker compose -f "${COMPOSE_PATH}" ${args}`,
    EXEC_OPTIONS,
  );
}

export interface ServiceStatus {
  name: string;
  state: string;
  health: string;
  port: string;
  image: string;
}

const PORT_MAP: Record<string, string> = {
  'node': '9944',
  'indexer': '8088',
  'proof-server': '6300',
};

/**
 * Parse `docker compose ps --format json` into structured status.
 * Returns empty array if no containers are running.
 */
export function getServiceStatus(): ServiceStatus[] {
  try {
    const output = dockerCompose('ps --format json');
    if (!output.trim()) return [];

    // docker compose ps --format json outputs one JSON object per line
    const lines = output.trim().split('\n');
    const services: ServiceStatus[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { Service?: string; State?: string; Health?: string; Image?: string; Publishers?: Array<{ PublishedPort?: number }> };
        const name = obj.Service ?? 'unknown';
        services.push({
          name,
          state: obj.State ?? 'unknown',
          health: obj.Health ?? '',
          port: PORT_MAP[name] ?? '',
          image: obj.Image ?? '',
        });
      } catch {
        // skip unparseable lines
      }
    }

    return services;
  } catch {
    return [];
  }
}

/**
 * Poll service health until all services are healthy or timeout expires.
 * Returns true if all healthy, false on timeout.
 */
export function waitForHealthy(timeoutMs: number = 120_000, intervalMs: number = 3_000): boolean {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const services = getServiceStatus();
    const allRunning = services.length === 3 &&
      services.every(s => s.state === 'running');

    if (allRunning) {
      // Check if services with healthchecks are healthy
      const healthyOrNoCheck = services.every(
        s => s.health === 'healthy' || s.health === ''
      );
      if (healthyOrNoCheck) return true;
    }

    // Sleep for the polling interval
    execSync(`sleep ${intervalMs / 1000}`, { timeout: intervalMs + 1_000 });
  }

  return false;
}

/** Return the compose file path (for display purposes). */
export function getComposePath(): string {
  return COMPOSE_PATH;
}

// Container names used in compose.yml — these are the hardcoded container_name values
export const CONTAINER_NAMES = ['node', 'indexer', 'proof-server'] as const;

/**
 * Force-remove containers by name, regardless of which compose project created them.
 * Returns the names of containers that were actually removed.
 */
export function removeConflictingContainers(): string[] {
  const removed: string[] = [];
  for (const name of CONTAINER_NAMES) {
    try {
      execSync(`docker rm -f "${name}"`, { ...EXEC_OPTIONS, timeout: 10_000 });
      removed.push(name);
    } catch {
      // Container doesn't exist or already removed — fine
    }
  }
  return removed;
}
