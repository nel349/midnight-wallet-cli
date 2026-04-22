// In-memory registry for two-step MCP confirmation tokens.
// Destructive tools (e.g. midnight_transfer) create a pending op + token
// instead of executing immediately. The agent shows the description to the
// user, gets consent, then calls midnight_confirm_operation with the token.

import { randomUUID } from 'node:crypto';

export interface PendingOperation {
  token: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateOptions {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

/** How long a pending operation remains valid, in milliseconds. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface ConfirmationStore {
  create(op: CreateOptions): PendingOperation;
  redeem(token: string): PendingOperation | null;
  /** Remove expired entries. Exposed for tests and periodic sweep. */
  sweep(now?: number): number;
  /** Test helper — current size. */
  size(): number;
}

export function createConfirmationStore(opts: { ttlMs?: number; now?: () => number } = {}): ConfirmationStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, PendingOperation>();

  const sweepInternal = (at: number): number => {
    let removed = 0;
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= at) {
        pending.delete(token);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    create(op) {
      const created = now();
      // Sweep expired entries on every create so unclaimed tokens from
      // user-declined prompts don't accumulate over a long session.
      sweepInternal(created);
      const token = randomUUID();
      const entry: PendingOperation = {
        token,
        tool: op.tool,
        args: op.args,
        description: op.description,
        createdAt: created,
        expiresAt: created + ttlMs,
      };
      pending.set(token, entry);
      return entry;
    },
    redeem(token) {
      const entry = pending.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        pending.delete(token);
        return null;
      }
      pending.delete(token);
      return entry;
    },
    sweep(at = now()) {
      return sweepInternal(at);
    },
    size() {
      return pending.size;
    },
  };
}
