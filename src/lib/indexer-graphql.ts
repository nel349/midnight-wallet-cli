// One GraphQL query to the indexer's HTTP endpoint.

/** The indexer could not answer a query: unreachable, an HTTP error, a non-JSON body, or GraphQL errors. */
export class IndexerQueryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'IndexerQueryError';
    Object.setPrototypeOf(this, IndexerQueryError.prototype);
  }
}

/** POST `query` to the indexer and return its `data`. Throws IndexerQueryError when there is none to return. */
export async function queryIndexer<TData>(
  indexerHttpUrl: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<TData> {
  let res: Response;
  try {
    res = await fetch(indexerHttpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(variables ? { query, variables } : { query }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new IndexerQueryError((err as Error).message);
  }
  if (!res.ok) throw new IndexerQueryError(`HTTP ${res.status} ${res.statusText}`.trim());
  let body: { data?: TData | null; errors?: Array<{ message: string }> };
  try {
    body = await res.json() as typeof body;
  } catch (err) {
    throw new IndexerQueryError(`the answer is not JSON: ${(err as Error).message}`);
  }
  if (body.errors?.length) throw new IndexerQueryError(body.errors.map((e) => e.message).join('; '));
  if (body.data == null) throw new IndexerQueryError('the answer has no data');
  return body.data;
}
