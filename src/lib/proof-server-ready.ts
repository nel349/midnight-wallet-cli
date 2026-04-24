// Proof-server readiness check — Docker marks proof-server as "running"
// with no healthcheck, so it can accept TCP connections before it's actually
// able to serve proof requests. A transfer that races in early gets
// "Failed to prove transaction" from the SDK's HttpProverClient. This helper
// polls the proof-server's `/` status endpoint until it returns a 2xx with
// `{"status":"ok",...}` before `mn localnet up` claims readiness.

export interface WaitForProofServerOptions {
  /** Overall deadline for the wait. Default 30s. */
  timeoutMs?: number;
  /** How often to re-poll while waiting. Default 1s. */
  pollIntervalMs?: number;
  /** Per-request timeout. Default 2s. */
  requestTimeoutMs?: number;
}

/**
 * Poll the proof server at `GET <url>/` until it responds with 2xx. Resolves
 * as soon as the probe succeeds; rejects on timeout.
 *
 * The proof-server returns a JSON body like `{"status":"ok","timestamp":"..."}`
 * on its root endpoint. We don't validate the body shape — any 2xx is enough
 * to prove the HTTP service is up.
 */
export async function waitForProofServerReady(
  proofServerUrl: string,
  opts: WaitForProofServerOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const requestTimeoutMs = opts.requestTimeoutMs ?? 2_000;
  const deadline = Date.now() + timeoutMs;
  // Normalise: accept both `http://host:port` and `http://host:port/`.
  const probeUrl = proofServerUrl.endsWith('/') ? proofServerUrl : proofServerUrl + '/';

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const res = await fetch(probeUrl, { method: 'GET', signal: controller.signal });
        if (res.ok) return;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Connection refused / aborted — proof server not up yet, retry.
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
  }

  throw new Error(`Proof server at ${probeUrl} did not respond within ${timeoutMs / 1000}s`);
}
