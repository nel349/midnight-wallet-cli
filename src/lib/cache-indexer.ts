// A network's cached sync state belongs to the indexer it was read from.
// The ids a wallet resumes from (ledger events, transactions) are the
// indexer's own numbering, not chain data: two indexers of the same chain
// disagree, and state resumed on another one replays the wrong events and
// never finishes ("values inserted non-linearly into dust generation tree").
// Preprod moved from Midnight's indexer to Blockfrost on 2026-10-09, whose
// numbering is 22 events behind.
//
// So each network's cache directory remembers its indexer, by host: never the
// URL, which can carry a Blockfrost project id. Before a cache is read, the
// directory is checked against the indexer in use; state from another one is
// removed, and the sync starts from the beginning.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CACHE_DIR_NAME, DIR_MODE, FILE_MODE, MIDNIGHT_DIR } from './constants.ts';

const MARKER = 'indexer.host';

/**
 * The indexer a network's caches came from when the directory says nothing:
 * they were written before the indexer was recorded, when these were the
 * networks' only defaults. A local network's is not known, and is taken to be
 * the one in use (a chain reset there is caught by the genesis hash).
 */
const INDEXER_BEFORE_IT_WAS_RECORDED: Readonly<Record<string, string>> = {
  preprod: 'indexer.preprod.midnight.network',
  preview: 'indexer.preview.midnight.network',
};

/** What tells one indexer from another: its host and port. */
export function indexerIdentity(indexerUrl: string): string {
  return new URL(indexerUrl).host;
}

export interface IndexerChange {
  /** The indexer the removed state came from. */
  previous: string;
  current: string;
  /** How many cache files were removed. */
  removed: number;
}

/**
 * Makes `network`'s cache directory belong to the indexer at `indexerUrl`.
 * Returns what was removed when its state came from another indexer, and
 * undefined when it already belonged to this one or held nothing.
 */
export function bindCachesToIndexer(network: string, indexerUrl: string, cacheDir?: string): IndexerChange | undefined {
  const current = indexerIdentity(indexerUrl);
  const dir = join(cacheDir ?? join(homedir(), MIDNIGHT_DIR, CACHE_DIR_NAME), network);
  const marker = join(dir, MARKER);

  const recorded = existsSync(marker) ? readFileSync(marker, 'utf-8').trim() : undefined;
  if (recorded === current) return undefined;

  const cached = existsSync(dir) ? readdirSync(dir).filter((file) => file.endsWith('.json')) : [];
  const previous = recorded ?? INDEXER_BEFORE_IT_WAS_RECORDED[network] ?? current;
  let removed = 0;
  if (previous !== current) {
    for (const file of cached) {
      unlinkSync(join(dir, file));
      removed++;
    }
  }

  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  writeFileSync(marker, current + '\n', { mode: FILE_MODE });
  return removed > 0 ? { previous, current, removed } : undefined;
}

/** One line for the user about a change `bindCachesToIndexer` reports. */
export function describeIndexerChange(network: string, change: IndexerChange): string {
  return `${network} is now read from ${change.current}; sync state saved from ${change.previous} can't be resumed there, so this sync starts from the beginning.`;
}
