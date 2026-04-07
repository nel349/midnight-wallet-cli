import { describe, it, expect, vi } from 'vitest';
import { isFacadeSynced } from '../lib/facade.ts';
import type { FacadeState } from '@midnight-ntwrk/wallet-sdk-facade';

/** Create a minimal FacadeState-like object for testing isFacadeSynced. */
function mockState({
  shieldedComplete = true,
  unshieldedComplete = true,
  dustComplete = true,
}: {
  shieldedComplete?: boolean;
  unshieldedComplete?: boolean;
  dustComplete?: boolean;
} = {}): FacadeState {
  return {
    shielded: {
      state: {
        progress: { isStrictlyComplete: () => shieldedComplete },
      },
    },
    unshielded: {
      progress: { isStrictlyComplete: () => unshieldedComplete },
    },
    dust: {
      state: {
        progress: { isStrictlyComplete: () => dustComplete },
      },
    },
  } as unknown as FacadeState;
}

describe('isFacadeSynced', () => {
  describe('full mode (default)', () => {
    it('returns true when all three wallets are synced', () => {
      expect(isFacadeSynced(mockState())).toBe(true);
    });

    it('returns false when shielded is not synced', () => {
      expect(isFacadeSynced(mockState({ shieldedComplete: false }))).toBe(false);
    });

    it('returns false when unshielded is not synced', () => {
      expect(isFacadeSynced(mockState({ unshieldedComplete: false }))).toBe(false);
    });

    it('returns false when dust is not synced', () => {
      expect(isFacadeSynced(mockState({ dustComplete: false }))).toBe(false);
    });

    it('returns false when multiple wallets are not synced', () => {
      expect(isFacadeSynced(mockState({ unshieldedComplete: false, dustComplete: false }))).toBe(false);
      expect(isFacadeSynced(mockState({ shieldedComplete: false, dustComplete: false }))).toBe(false);
      expect(isFacadeSynced(mockState({ shieldedComplete: false, unshieldedComplete: false }))).toBe(false);
    });

    it('defaults to full mode when syncMode is omitted', () => {
      // shielded not synced + no syncMode → should be false (full mode)
      expect(isFacadeSynced(mockState({ shieldedComplete: false }))).toBe(false);
    });
  });

  describe('lite mode', () => {
    it('returns true when unshielded + dust are synced, even if shielded is not', () => {
      expect(isFacadeSynced(mockState({ shieldedComplete: false }), 'lite')).toBe(true);
    });

    it('returns true when all three are synced', () => {
      expect(isFacadeSynced(mockState(), 'lite')).toBe(true);
    });

    it('returns false when unshielded is not synced', () => {
      expect(isFacadeSynced(mockState({ unshieldedComplete: false }), 'lite')).toBe(false);
    });

    it('returns false when dust is not synced', () => {
      expect(isFacadeSynced(mockState({ dustComplete: false }), 'lite')).toBe(false);
    });

    it('returns false when both unshielded and dust are not synced', () => {
      expect(isFacadeSynced(mockState({ unshieldedComplete: false, dustComplete: false }), 'lite')).toBe(false);
    });

    it('never evaluates shielded progress', () => {
      const shieldedSpy = vi.fn().mockReturnValue(false);
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: shieldedSpy } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: { state: { progress: { isStrictlyComplete: () => true } } },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'lite')).toBe(true);
      expect(shieldedSpy).not.toHaveBeenCalled();
    });
  });

  describe('dust index fallback', () => {
    it('uses appliedIndex >= highestRelevantWalletIndex when isStrictlyComplete returns false', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              appliedIndex: 100,
              highestRelevantWalletIndex: 50,
            },
          },
        },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'full')).toBe(true);
      expect(isFacadeSynced(state, 'lite')).toBe(true);
    });

    it('returns false when appliedIndex < highestRelevantWalletIndex', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              appliedIndex: 10,
              highestRelevantWalletIndex: 50,
            },
          },
        },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'full')).toBe(false);
      expect(isFacadeSynced(state, 'lite')).toBe(false);
    });

    it('treats 0/0 dust as synced when unshielded is complete (unfunded wallet)', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              appliedIndex: 0,
              highestRelevantWalletIndex: 0,
            },
          },
        },
      } as unknown as FacadeState;

      // Unshielded is synced, dust is 0/0 → unfunded wallet, nothing to sync
      expect(isFacadeSynced(state, 'full')).toBe(true);
      expect(isFacadeSynced(state, 'lite')).toBe(true);
    });

    it('does not use 0/0 fallback when unshielded is not yet synced', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => false } } },
        unshielded: { progress: { isStrictlyComplete: () => false } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              appliedIndex: 0,
              highestRelevantWalletIndex: 0,
            },
          },
        },
      } as unknown as FacadeState;

      // Nothing is synced yet — 0/0 on dust could be initial state, not unfunded
      expect(isFacadeSynced(state, 'full')).toBe(false);
      expect(isFacadeSynced(state, 'lite')).toBe(false);
    });

    it('works in lite mode with shielded not synced', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => false } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => false,
              appliedIndex: 100,
              highestRelevantWalletIndex: 100,
            },
          },
        },
      } as unknown as FacadeState;

      // lite: should be true (shielded ignored, dust caught up via fallback)
      expect(isFacadeSynced(state, 'lite')).toBe(true);
      // full: should be false (shielded not synced)
      expect(isFacadeSynced(state, 'full')).toBe(false);
    });
  });

  describe('edge cases — null/undefined state fields', () => {
    it('returns false when unshielded progress is undefined', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: {},
        dust: { state: { progress: { isStrictlyComplete: () => true } } },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'full')).toBe(false);
      expect(isFacadeSynced(state, 'lite')).toBe(false);
    });

    it('returns false when dust state is undefined', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {},
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'full')).toBe(false);
      expect(isFacadeSynced(state, 'lite')).toBe(false);
    });

    it('returns false when shielded state is undefined in full mode', () => {
      const state = {
        shielded: {},
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: { state: { progress: { isStrictlyComplete: () => true } } },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'full')).toBe(false);
    });

    it('returns true when shielded state is undefined in lite mode', () => {
      const state = {
        shielded: {},
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: { state: { progress: { isStrictlyComplete: () => true } } },
      } as unknown as FacadeState;

      expect(isFacadeSynced(state, 'lite')).toBe(true);
    });
  });

  describe('edge cases — isStrictlyComplete throws', () => {
    it('propagates dust isStrictlyComplete throw (not silently caught)', () => {
      const state = {
        shielded: { state: { progress: { isStrictlyComplete: () => true } } },
        unshielded: { progress: { isStrictlyComplete: () => true } },
        dust: {
          state: {
            progress: {
              isStrictlyComplete: () => { throw new Error('corrupted'); },
            },
          },
        },
      } as unknown as FacadeState;

      // isStrictlyComplete throwing is not caught — it propagates.
      // Only the fallback index check is wrapped in try-catch.
      expect(() => isFacadeSynced(state, 'full')).toThrow('corrupted');
      expect(() => isFacadeSynced(state, 'lite')).toThrow('corrupted');
    });
  });
});
