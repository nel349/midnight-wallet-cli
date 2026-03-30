import { describe, it, expect } from 'vitest';
import { runAssertions, type AssertionContext } from '../lib/test/assertions.ts';
import type { AssertionCheck } from '../lib/test/types.ts';

describe('runAssertions', () => {
  describe('balance-changed', () => {
    const ctx: AssertionContext = {
      preBalance: '1000000',
      postBalance: '500000',
    };

    it('passes when balance decreased and direction is "decreased"', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: { direction: 'decreased' }, expect: 'pass',
      }];
      const results = await runAssertions(checks, ctx);
      expect(results[0].status).toBe('pass');
    });

    it('fails when balance decreased but direction is "increased"', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: { direction: 'increased' }, expect: 'pass',
      }];
      const results = await runAssertions(checks, ctx);
      expect(results[0].status).toBe('fail');
    });

    it('handles expect: "fail" correctly', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: { direction: 'increased' }, expect: 'fail',
      }];
      const results = await runAssertions(checks, ctx);
      // Evaluation returns false (not increased), but expect is 'fail', so overall passes
      expect(results[0].status).toBe('pass');
    });

    it('fails when no balance data available', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: {}, expect: 'pass',
      }];
      const results = await runAssertions(checks, {});
      expect(results[0].status).toBe('fail');
      expect(results[0].message).toContain('Balance data not available');
    });

    it('passes on any change with no direction specified', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: {}, expect: 'pass',
      }];
      const results = await runAssertions(checks, ctx);
      expect(results[0].status).toBe('pass');
    });

    it('unchanged returns true when balances are equal', async () => {
      const checks: AssertionCheck[] = [{
        id: 'bal', type: 'balance-changed', params: { direction: 'unchanged' }, expect: 'pass',
      }];
      const results = await runAssertions(checks, { preBalance: '1000', postBalance: '1000' });
      expect(results[0].status).toBe('pass');
    });
  });

  describe('process-exit-code', () => {
    it('passes when exit code matches', async () => {
      const checks: AssertionCheck[] = [{
        id: 'exit', type: 'process-exit-code', params: { code: 0 }, expect: 'pass',
      }];
      const results = await runAssertions(checks, { processExitCode: 0 });
      expect(results[0].status).toBe('pass');
    });

    it('fails when exit code does not match', async () => {
      const checks: AssertionCheck[] = [{
        id: 'exit', type: 'process-exit-code', params: { code: 0 }, expect: 'pass',
      }];
      const results = await runAssertions(checks, { processExitCode: 1 });
      expect(results[0].status).toBe('fail');
    });

    it('fails when exit code not available', async () => {
      const checks: AssertionCheck[] = [{
        id: 'exit', type: 'process-exit-code', params: { code: 0 }, expect: 'pass',
      }];
      const results = await runAssertions(checks, {});
      expect(results[0].status).toBe('fail');
      expect(results[0].message).toContain('not available');
    });
  });

  describe('unsupported types', () => {
    it('fails with message for unsupported type', async () => {
      const checks: AssertionCheck[] = [{
        id: 'ledger', type: 'ledger-field', params: {}, expect: 'pass',
      }];
      const results = await runAssertions(checks, {});
      expect(results[0].status).toBe('fail');
      expect(results[0].message).toContain('Unsupported assertion type');
    });
  });

  describe('multiple checks', () => {
    it('runs all checks independently', async () => {
      const checks: AssertionCheck[] = [
        { id: 'exit-ok', type: 'process-exit-code', params: { code: 0 }, expect: 'pass' },
        { id: 'exit-fail', type: 'process-exit-code', params: { code: 1 }, expect: 'pass' },
      ];
      const results = await runAssertions(checks, { processExitCode: 0 });
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('pass');
      expect(results[1].status).toBe('fail'); // expected code 1 but got 0
    });
  });
});
