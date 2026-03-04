import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  renderApprovalBox,
  isReadOnlyMethod,
  promptApproval,
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
      // Should NOT have generic title
      expect(output).not.toContain('DApp Request');
    });

    it('renders details with labels and values', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [
          { label: 'Amount', value: '10.000000 NIGHT' },
          { label: 'To', value: 'mn_addr_undeployed1abc...' },
        ],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('Amount:');
      expect(output).toContain('10.000000 NIGHT');
      expect(output).toContain('To:');
      expect(output).toContain('mn_addr_undeployed1abc...');
    });

    it('uses heavy box drawing characters', () => {
      const request: ApprovalRequest = {
        method: 'makeTransfer',
        network: 'undeployed',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      expect(output).toContain('╔');
      expect(output).toContain('╗');
      expect(output).toContain('╚');
      expect(output).toContain('╝');
    });

    it('renders Action and Network on separate lines', () => {
      const request: ApprovalRequest = {
        method: 'signData',
        network: 'preprod',
        details: [],
      };

      const output = stripAnsi(renderApprovalBox(request));
      const lines = output.split('\n');
      const actionLine = lines.find(l => l.includes('Action:'));
      const networkLine = lines.find(l => l.includes('Network:'));
      expect(actionLine).toBeDefined();
      expect(networkLine).toBeDefined();
      expect(actionLine).toContain('signData');
      expect(networkLine).toContain('preprod');
    });
  });

  describe('promptApproval', () => {
    const baseRequest: ApprovalRequest = {
      method: 'makeTransfer',
      network: 'undeployed',
      details: [],
    };

    let stderrOutput: string[];
    let origWrite: typeof process.stderr.write;

    beforeEach(() => {
      stderrOutput = [];
      origWrite = process.stderr.write;
      process.stderr.write = ((...args: any[]) => {
        stderrOutput.push(String(args[0]));
        return true;
      }) as any;
    });

    afterEach(() => {
      process.stderr.write = origWrite;
    });

    it('auto-approves when approveAll is true', async () => {
      const result = await promptApproval(baseRequest, { approveAll: true });
      expect(result).toBe('approve');
    });

    it('logs auto-approval for approveAll', async () => {
      await promptApproval(baseRequest, { approveAll: true });
      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Auto-approved: makeTransfer');
    });

    it('auto-approves read-only methods when autoApproveReads is true', async () => {
      const readRequest: ApprovalRequest = {
        method: 'getUnshieldedBalances',
        network: 'undeployed',
        details: [],
      };
      const result = await promptApproval(readRequest, { autoApproveReads: true });
      expect(result).toBe('approve');
    });

    it('logs auto-approval for read-only methods', async () => {
      const readRequest: ApprovalRequest = {
        method: 'getUnshieldedBalances',
        network: 'undeployed',
        details: [],
      };
      await promptApproval(readRequest, { autoApproveReads: true });
      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('Auto-approved (read-only)');
    });

    it('does not auto-approve write methods when only autoApproveReads is set', async () => {
      // Non-TTY stdin will cause immediate rejection
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const result = await promptApproval(baseRequest, { autoApproveReads: true });
      expect(result).toBe('reject');

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });

    it('rejects when stdin is not a TTY', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const result = await promptApproval(baseRequest);
      expect(result).toBe('reject');

      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('stdin is not a TTY');

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });

    it('rejects concurrent prompts when one is already active', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

      // Start the first prompt — it will block waiting for readline input
      const first = promptApproval(baseRequest);

      // The second call should immediately reject because promptActive is true
      const second = await promptApproval(baseRequest);
      expect(second).toBe('reject');

      const written = stripAnsi(stderrOutput.join(''));
      expect(written).toContain('another approval prompt is active');

      // Clean up the first prompt by closing stdin's readline
      // Emit a fake answer to unblock the first prompt
      process.stdin.emit('data', 'a\n');
      // Give it a tick to process
      await new Promise((r) => setTimeout(r, 50));
      // If still hanging, it'll be cleaned up by process exit — acceptable for test

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });
  });
});
