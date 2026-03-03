import { describe, it, expect } from 'vitest';
import {
  renderApprovalBox,
  isReadOnlyMethod,
  type ApprovalRequest,
} from '../lib/approval.ts';

// Strip ANSI codes for content assertions
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('approval', () => {
  describe('isReadOnlyMethod', () => {
    it('returns true for read-only methods', () => {
      expect(isReadOnlyMethod('getUnshieldedBalances')).toBe(true);
      expect(isReadOnlyMethod('getShieldedBalances')).toBe(true);
      expect(isReadOnlyMethod('getDustBalance')).toBe(true);
      expect(isReadOnlyMethod('getShieldedAddresses')).toBe(true);
      expect(isReadOnlyMethod('getUnshieldedAddress')).toBe(true);
      expect(isReadOnlyMethod('getDustAddress')).toBe(true);
      expect(isReadOnlyMethod('getTxHistory')).toBe(true);
      expect(isReadOnlyMethod('getConfiguration')).toBe(true);
      expect(isReadOnlyMethod('getConnectionStatus')).toBe(true);
    });

    it('returns false for write methods', () => {
      expect(isReadOnlyMethod('makeTransfer')).toBe(false);
      expect(isReadOnlyMethod('submitTransaction')).toBe(false);
      expect(isReadOnlyMethod('balanceUnsealedTransaction')).toBe(false);
      expect(isReadOnlyMethod('balanceSealedTransaction')).toBe(false);
      expect(isReadOnlyMethod('signData')).toBe(false);
      expect(isReadOnlyMethod('makeIntent')).toBe(false);
    });

    it('returns false for unknown methods', () => {
      expect(isReadOnlyMethod('unknownMethod')).toBe(false);
    });
  });

  describe('renderApprovalBox', () => {
    it('renders a box with method and network', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('DApp Request');
      expect(output).toContain('makeTransfer');
      expect(output).toContain('undeployed');
      expect(output).toContain('[A]pprove');
      expect(output).toContain('[R]eject');
    });

    it('includes dapp name when provided', () => {
      const request: ApprovalRequest = {
        method: 'submitTransaction',
        dappName: 'MyDEX',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('Request from "MyDEX"');
    });

    it('renders details', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [
          { label: 'Amount', value: '10.000000 NIGHT' },
          { label: 'To', value: 'mn_addr_undeployed1abc...' },
        ],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('Amount');
      expect(output).toContain('10.000000 NIGHT');
      expect(output).toContain('To');
      expect(output).toContain('mn_addr_undeployed1abc...');
    });

    it('uses box drawing characters', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      // Heavy box style uses ╔ ╗ ╚ ╝ ═ ║
      expect(output).toContain('╔');
      expect(output).toContain('╗');
      expect(output).toContain('╚');
      expect(output).toContain('╝');
    });
  });
});
