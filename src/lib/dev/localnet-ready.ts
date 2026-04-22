// Ensures the local Midnight network is running for `mn dev`.
// Idempotent: skip fast when all services are already healthy.

import { CONTAINER_NAMES, dockerCompose, ensureComposeFile, getServiceStatus, waitForHealthy } from '../localnet.ts';

export type LocalnetState = 'already-running' | 'started' | 'started-unhealthy';

export interface EnsureLocalnetResult {
  state: LocalnetState;
}

/**
 * Make sure localnet is up. Returns quickly if the core services
 * (node, indexer, proof-server) are already healthy.
 */
export async function ensureLocalnetRunning(onProgress?: (msg: string) => void): Promise<EnsureLocalnetResult> {
  if (allExpectedServicesHealthy()) {
    onProgress?.('Localnet already running');
    return { state: 'already-running' };
  }

  onProgress?.('Writing compose file');
  ensureComposeFile();

  onProgress?.('Starting localnet containers');
  dockerCompose('up -d');

  onProgress?.('Waiting for services to be healthy');
  const healthy = waitForHealthy(120_000);

  return { state: healthy ? 'started' : 'started-unhealthy' };
}

function safeServiceStatus(): ReturnType<typeof getServiceStatus> {
  try {
    return getServiceStatus();
  } catch {
    return [];
  }
}

/**
 * True when every expected container (node, indexer, proof-server) is running
 * AND reports healthy (or has no health check configured).
 */
function allExpectedServicesHealthy(): boolean {
  const services = safeServiceStatus();
  const byName = new Map(services.map((s) => [s.name, s]));
  for (const name of CONTAINER_NAMES) {
    const svc = byName.get(name);
    if (!svc) return false;
    if (svc.state !== 'running') return false;
    // Containers without a health check report health as "" — treat that as OK.
    // Only fail when a health check is configured AND reporting non-healthy.
    if (svc.health && svc.health !== 'healthy') return false;
  }
  return true;
}
