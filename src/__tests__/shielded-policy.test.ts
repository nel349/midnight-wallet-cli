import { describe, it, expect } from 'vitest';
import { networkHasShielded, shieldedSyncEnabled, shieldedDisabledReason } from '../lib/shielded-policy.ts';

describe('shielded-policy', () => {
  it('marks localnet (undeployed) as having shielded, hosted testnets as not', () => {
    expect(networkHasShielded('undeployed')).toBe(true);
    expect(networkHasShielded('preview')).toBe(false);
    expect(networkHasShielded('preprod')).toBe(false);
  });

  it('enables shielded sync on undeployed regardless of the force flag', () => {
    expect(shieldedSyncEnabled('undeployed', false)).toBe(true);
    expect(shieldedSyncEnabled('undeployed', true)).toBe(true);
  });

  it('disables shielded sync on preview/preprod by default', () => {
    expect(shieldedSyncEnabled('preview', false)).toBe(false);
    expect(shieldedSyncEnabled('preprod', false)).toBe(false);
  });

  it('re-enables shielded sync on preview/preprod when forced', () => {
    expect(shieldedSyncEnabled('preview', true)).toBe(true);
    expect(shieldedSyncEnabled('preprod', true)).toBe(true);
  });

  it('names the network and the override in the reason', () => {
    const reason = shieldedDisabledReason('preprod');
    expect(reason).toContain('preprod');
    expect(reason).toContain('--force-shielded');
  });
});
