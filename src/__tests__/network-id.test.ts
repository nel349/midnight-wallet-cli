import { describe, it, expect } from 'vitest';
import { getNetworkId } from '../lib/network-id.ts';
import { NetworkId } from '@midnight-ntwrk/wallet-sdk-abstractions';

describe('getNetworkId', () => {
  it('returns Undeployed for "Undeployed"', () => {
    expect(getNetworkId('Undeployed')).toBe(NetworkId.NetworkId.Undeployed);
  });

  it('returns PreProd for "PreProd"', () => {
    expect(getNetworkId('PreProd')).toBe(NetworkId.NetworkId.PreProd);
  });

  it('returns Preview for "Preview"', () => {
    expect(getNetworkId('Preview')).toBe(NetworkId.NetworkId.Preview);
  });

  it('throws for unknown networkId', () => {
    expect(() => getNetworkId('Mainnet')).toThrow('Unknown networkId: Mainnet');
  });

  it('is case-sensitive', () => {
    expect(() => getNetworkId('undeployed')).toThrow('Unknown networkId');
    expect(() => getNetworkId('PREPROD')).toThrow('Unknown networkId');
  });
});
