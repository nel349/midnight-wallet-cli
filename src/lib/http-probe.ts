// Whether a local service answers HTTP, without shelling out to curl: mn needs
// Node and Docker, and a slim container image or a bare Windows shell has no curl.

/**
 * True when anything answers HTTP at `url` within `timeoutMs`. Any status
 * counts (a GraphQL endpoint answers a bare GET with 4xx); a refused, reset or
 * silent connection does not.
 */
export async function httpAnswers(url: string, timeoutMs: number): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}
