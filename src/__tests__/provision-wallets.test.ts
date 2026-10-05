// Dev wallet provisioning order. A ledger-9 registration waits for its NIGHT
// to generate the fee, and generation starts at the airdrop, so every new
// wallet is funded before any registers. The steps are injected (the real
// ones run mn's commands against a chain); HOME is a temporary directory.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionDevWallets, type ProvisionSteps } from '../lib/dev/provision-wallets.ts';

let home: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'mn-provision-'));
  process.env.HOME = home;
  mkdirSync(join(home, '.midnight', 'wallets'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

function recordingSteps(calls: string[]): ProvisionSteps {
  return {
    generate: async (name) => { calls.push(`generate ${name}`); },
    airdrop: async (name, amount) => { calls.push(`airdrop ${name} ${amount}`); },
    registerDust: async (name) => { calls.push(`register ${name}`); },
  };
}

describe('provisionDevWallets', () => {
  it('funds every new wallet before registering any, and leaves existing ones alone', async () => {
    writeFileSync(join(home, '.midnight', 'wallets', 'dev-bob.json'), '{}');
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await provisionDevWallets({
      names: ['dev-alice', 'dev-bob', 'dev-carol'],
      amountNight: 1000,
      steps: recordingSteps(calls),
      onProgress: (wallet, phase) => progress.push(`${wallet}:${phase}`),
    });

    expect(calls).toEqual([
      'generate dev-alice', 'airdrop dev-alice 1000',
      'generate dev-carol', 'airdrop dev-carol 1000',
      'register dev-alice', 'register dev-carol',
    ]);
    expect(result).toEqual([
      { name: 'dev-alice', state: 'created' },
      { name: 'dev-bob', state: 'reused' },
      { name: 'dev-carol', state: 'created' },
    ]);
    expect(progress).toEqual([
      'dev-alice:creating', 'dev-alice:funding', 'dev-bob:done', 'dev-carol:creating', 'dev-carol:funding',
      'dev-alice:dust', 'dev-alice:done', 'dev-carol:dust', 'dev-carol:done',
    ]);
  });

  it('stops before registering when cancelled after funding', async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const steps = recordingSteps(calls);
    const airdrop = steps.airdrop;
    steps.airdrop = async (name, amount, signal) => { await airdrop(name, amount, signal); controller.abort(); };

    await expect(provisionDevWallets({ names: ['dev-alice'], amountNight: 1000, steps, signal: controller.signal })).rejects.toThrow();
    expect(calls).toEqual(['generate dev-alice', 'airdrop dev-alice 1000']);
  });
});
