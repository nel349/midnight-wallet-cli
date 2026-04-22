// Ensures the local Midnight network is running for `mn dev`.
// Idempotent: skip fast when all services are already healthy.

import { dockerCompose, ensureComposeFile, getServiceStatus, waitForHealthy } from '../localnet.ts';

export type LocalnetState = 'already-running' | 'started' | 'started-unhealthy';

export interface EnsureLocalnetResult {
  state: LocalnetState;
}

/**
 * Make sure localnet is up. Returns quickly if the core services
 * (node, indexer, proof-server) are already healthy.
 */
export async function ensureLocalnetRunning(onProgress?: (msg: string) => void): Promise<EnsureLocalnetResult> {
  const services = safeServiceStatus();
  const allHealthy = services.length > 0 && services.every((s) => s.state === 'running' && (s.health ?? 'healthy') === 'healthy');
  if (allHealthy) {
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
