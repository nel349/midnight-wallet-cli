import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runAssertions, type AssertionContext } from '../lib/test/assertions.ts';
import type { AssertionCheck } from '../lib/test/types.ts';

const tmpBase = join(tmpdir(), 'mn-agent-report-' + Date.now());
mkdirSync(tmpBase, { recursive: true });

afterAll(() => {
  try { rmSync(tmpBase, { recursive: true }); } catch {}
});

function logFile(name: string, content: string): string {
  const path = join(tmpBase, `${name}.log`);
  writeFileSync(path, content);
  return path;
}

const baseCheck: AssertionCheck = {
  id: 'agent-no-failure',
  type: 'agent-report-no-failure',
  params: {},
  expect: 'pass',
};

async function runWith(check: AssertionCheck, ctx: AssertionContext): Promise<{ status: string; message?: string }> {
  const [result] = await runAssertions([check], ctx);
  return { status: result.status, message: result.message };
}

describe('agent-report-no-failure', () => {
  it('passes on a clean success report', async () => {
    const path = logFile('clean', `
## Report
| Step | Result |
|------|--------|
| 1 | PASS |
| 2 | PASS |
All steps completed.
    `);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('pass');
  });

  it('fails when Claude reports FAILED outside code blocks', async () => {
    const path = logFile('failed', `
## Report
| 1 | PASS |
| 2 | FAILED — element not found |
    `);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('fail');
  });

  it('fails on the ❌ emoji marker', async () => {
    const path = logFile('emoji', `
## Step results
1. ✅ Connected
2. ❌ No history row appeared
    `);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('fail');
  });

  it('matches the exact false-PASS pattern from the zkloan run', async () => {
    // Real-shape report Claude wrote during the false-PASS run.
    const path = logFile('zkloan', `
## E2E Test Report — zkloan-credit-scorer (FAILED)

| # | Step | Result |
|---|------|--------|
| 1 | Open localhost — header network badge "Undeployed" | ✅ |
| 5 | Fill loan amount, click "Request loan →" | ❌ |
| 6 | Verify history entry "Approved" | ❌ (no record created) |
    `);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('fail');
  });

  it('ignores failure markers inside code blocks (quoted dApp errors)', async () => {
    const path = logFile('quoted', `
## Report
All steps passed. Note that the dApp logged this error from a previous test:

\`\`\`
Error: failed assert: Loan amount must be greater than zero
Test FAILED at step 5
\`\`\`

This is dApp output from an earlier run, not a current failure.
    `);
    // Even though "FAILED" appears, it's inside a code block — Claude is
    // quoting the dApp, not declaring this test failed.
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('pass');
  });

  it('ignores inline-code failure mentions', async () => {
    const path = logFile('inline', `
The error code constant \`FAIL\` is defined in the SDK. All my steps passed.
    `);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('pass');
  });

  it('passes when no log file is set (CLI strategy — nothing to scan)', async () => {
    expect((await runWith(baseCheck, {})).status).toBe('pass');
  });

  it('passes when the log path points to a non-existent file', async () => {
    expect((await runWith(baseCheck, { agentLogPath: join(tmpBase, 'does-not-exist.log') })).status).toBe('pass');
  });

  it('respects custom markers via params.markers', async () => {
    const path = logFile('custom', `Some report. The agent says: NOPE.`);
    const customCheck: AssertionCheck = {
      ...baseCheck,
      params: { markers: ['NOPE'] },
    };
    expect((await runWith(customCheck, { agentLogPath: path })).status).toBe('fail');

    // And the default markers don't catch it
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('pass');
  });

  it('match is case-insensitive', async () => {
    const path = logFile('case', `step 3: failed.`);
    expect((await runWith(baseCheck, { agentLogPath: path })).status).toBe('fail');
  });

  it('explicit logPath in params overrides the context path', async () => {
    const goodPath = logFile('good', 'all steps passed');
    const badPath = logFile('bad', 'step 1: FAILED');
    const customCheck: AssertionCheck = {
      ...baseCheck,
      params: { logPath: badPath },
    };
    // Context says "good", but params override → uses bad → fails.
    expect((await runWith(customCheck, { agentLogPath: goodPath })).status).toBe('fail');
  });
});
