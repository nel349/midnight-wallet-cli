import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  describeApprovalPolicy,
  renderApprovalBox,
  isReadOnlyMethod,
  isPrepMethod,
  promptApproval,
  type ApprovalOptions,
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

    it('returns false for write and prep methods', () => {
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

  describe('isPrepMethod', () => {
    it('returns true for balance transaction methods', () => {
      expect(isPrepMethod('balanceUnsealedTransaction')).toBe(true);
      expect(isPrepMethod('balanceSealedTransaction')).toBe(true);
    });

    it('returns false for write methods', () => {
      expect(isPrepMethod('submitTransaction')).toBe(false);
      expect(isPrepMethod('makeTransfer')).toBe(false);
      expect(isPrepMethod('signData')).toBe(false);
      expect(isPrepMethod('makeIntent')).toBe(false);
    });

    it('returns false for read-only methods', () => {
      expect(isPrepMethod('getUnshieldedBalances')).toBe(false);
      expect(isPrepMethod('getConfiguration')).toBe(false);
    });

    it('returns false for unknown methods', () => {
      expect(isPrepMethod('unknownMethod')).toBe(false);
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

    // Balancing signs and returns a finished transaction a dApp can submit
    // through any node, so it is a write: it prompts unless --approve-all, or
    // --approve-fees for a fee-only balance.
    it.each(['balanceUnsealedTransaction', 'balanceSealedTransaction'])(
      'prompts for %s even with autoApproveReads (no terminal: rejected), naming the flags that would approve it',
      async (method) => {
        const origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
        try {
          const result = await promptApproval({ method, network: 'undeployed', details: [] }, { autoApproveReads: true });
          expect(result).toBe('reject');
          const written = stripAnsi(stderrOutput.join(''));
          expect(written).not.toContain('Auto-approved');
          expect(written).toContain('Balancing prompts like any other write: use --approve-all for non-interactive environments, or --approve-fees');
        } finally {
          Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
        }
      },
    );

    it('does not auto-approve balancing when autoApproveReads is false', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const prepRequest: ApprovalRequest = {
        method: 'balanceUnsealedTransaction',
        network: 'undeployed',
        details: [],
      };
      const result = await promptApproval(prepRequest, { autoApproveReads: false });
      expect(result).toBe('reject'); // falls through to non-TTY rejection

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });

    it('does not auto-approve write methods when only autoApproveReads is set', async () => {
      // Non-TTY stdin will cause immediate rejection
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

      const result = await promptApproval(baseRequest, { autoApproveReads: true });
      expect(result).toBe('reject');

      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
    });

    describe('fee-only policy (--approve-fees)', () => {
      // Every case runs non-interactively: an agent can't answer a prompt,
      // so anything the policy doesn't approve must be rejected outright.
      let origIsTTY: boolean | undefined;
      beforeEach(() => {
        origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      });
      afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      });

      it.each(['balanceUnsealedTransaction', 'balanceSealedTransaction', 'submitTransaction'])(
        'auto-approves a fee-only %s and says why',
        async (method) => {
          const result = await promptApproval({ ...baseRequest, method, feeOnly: true }, { approveFees: true });
          expect(result).toBe('approve');
          expect(stripAnsi(stderrOutput.join(''))).toContain(`Auto-approved (fee-only): ${method}`);
        },
      );

      it.each(['makeTransfer', 'makeIntent', 'signData', 'submitTransaction', 'balanceUnsealedTransaction'])(
        'rejects %s when it is not fee-only',
        async (method) => {
          const result = await promptApproval({ ...baseRequest, method }, { approveFees: true });
          expect(result).toBe('reject');
        },
      );

      it('grants nothing from a fee-only request when the server was not started with --approve-fees', async () => {
        const result = await promptApproval({ ...baseRequest, method: 'submitTransaction', feeOnly: true }, {});
        expect(result).toBe('reject');
      });
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

    describe('without a terminal, the hint names what the server could have been started with', () => {
      let origIsTTY: boolean | undefined;
      beforeEach(() => {
        origIsTTY = process.stdin.isTTY;
        Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      });
      afterEach(() => {
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      });

      it('suggests --approve-all, or --approve-fees for a fee wallet, on a server with neither', async () => {
        expect(await promptApproval(baseRequest)).toBe('reject');
        const written = stripAnsi(stderrOutput.join(''));
        expect(written).toContain('makeTransfer needs a terminal to approve: use --approve-all for non-interactive environments, or --approve-fees for a fee wallet');
      });

      it('on a fee wallet, says the request is outside --approve-fees and names the method', async () => {
        expect(await promptApproval(baseRequest, { approveFees: true })).toBe('reject');
        const written = stripAnsi(stderrOutput.join(''));
        expect(written).toContain("--approve-fees approves only paying the Dust fee for an agent's own balanced transaction");
        expect(written).toContain('makeTransfer needs a terminal to approve');
        expect(written).not.toContain('Use --approve-all');
      });
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

describe('describeApprovalPolicy (what mn serve reports, in its header and --json)', () => {
  const limits = { maxFeeSpecks: 10n ** 15n / 2n, maxPending: 3 };

  it.each([
    ['--approve-all', { approveAll: true, autoApproveReads: true }, { reads: 'auto', balancing: 'auto', writes: 'auto' }],
    ['--approve-fees', { approveFees: true, autoApproveReads: true }, {
      reads: 'auto', balancing: 'fee-only', writes: 'fee-only', feeLimits: { maxFeeSpecks: '500000000000000', maxPending: 3 },
    }],
    ['the default', { autoApproveReads: true }, { reads: 'auto', balancing: 'prompt', writes: 'prompt' }],
    ['--no-auto-approve-reads', {}, { reads: 'auto', balancing: 'prompt', writes: 'prompt' }],
  ] as const)('%s', (_flags, options, expected) => {
    expect(describeApprovalPolicy(options, limits)).toEqual(expected);
  });

  it('is plain JSON (no bigint), so --json can print it', () => {
    expect(() => JSON.stringify(describeApprovalPolicy({ approveFees: true }, limits))).not.toThrow();
  });

  describe('matches what promptApproval decides without a terminal', () => {
    let origIsTTY: boolean | undefined;
    let origWrite: typeof process.stderr.write;
    beforeEach(() => {
      origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      origWrite = process.stderr.write;
      process.stderr.write = (() => true) as any;
    });
    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true });
      process.stderr.write = origWrite;
    });

    const decide = (method: string, options: ApprovalOptions, feeOnly = false) =>
      promptApproval({ method, network: 'undeployed', details: [], feeOnly }, options);
    // What each claim means for a request of that kind: 'auto' approves anything,
    // 'fee-only' approves only a fee-only request, 'prompt' approves nothing.
    const expectedFor = (claim: string, feeOnly: boolean) =>
      claim === 'auto' || (claim === 'fee-only' && feeOnly) ? 'approve' : 'reject';

    it.each([
      [{ approveAll: true, autoApproveReads: true }],
      [{ approveFees: true, autoApproveReads: true }],
      [{ autoApproveReads: true }],
      [{}],
    ] as Array<[ApprovalOptions]>)('%j', async (options) => {
      const policy = describeApprovalPolicy(options, limits);
      for (const feeOnly of [false, true]) {
        for (const method of ['balanceUnsealedTransaction', 'balanceSealedTransaction']) {
          expect(await decide(method, options, feeOnly), `${method} feeOnly=${feeOnly}`).toBe(expectedFor(policy.balancing, feeOnly));
        }
        for (const method of ['submitTransaction', 'makeTransfer', 'makeIntent', 'signData']) {
          const claimed = method === 'submitTransaction' ? expectedFor(policy.writes, feeOnly) : expectedFor(policy.writes, false);
          expect(await decide(method, options, feeOnly && method === 'submitTransaction'), `${method} feeOnly=${feeOnly}`).toBe(claimed);
        }
      }
    });
  });
});
