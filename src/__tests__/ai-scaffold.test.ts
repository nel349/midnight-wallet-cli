import { describe, it, expect } from 'vitest';

import { buildCliPrompt, buildUiPrompt, renderContractSummary, RESPONSE_FENCE } from '../lib/test/ai-prompts.ts';
import { generateCliScaffoldWithAI, generateUiScaffoldWithAI } from '../lib/test/ai-scaffold.ts';
import type { CircuitInfo, ContractInfo } from '../lib/contract/inspect.ts';
import type { ScreenCandidate } from '../lib/test/discover-screens.ts';

const counterContract: ContractInfo = {
  name: 'counter',
  managedDir: '/tmp/contract/src/managed/counter',
  compilerVersion: '0.30.0',
  languageVersion: '0.22.0',
  runtimeVersion: '0.15.0',
  siblings: [],
  circuits: [
    {
      name: 'increment',
      pure: false,
      proof: true,
      arguments: [],
      'result-type': { 'type-name': 'Tuple', types: [] },
    },
  ],
  witnesses: [],
};

const incrementCircuit = counterContract.circuits[0];

// ── Prompt builders ──

describe('renderContractSummary', () => {
  it('lists circuits with arity and purity', () => {
    const out = renderContractSummary({
      name: 'counter',
      circuits: [
        { name: 'increment', pure: false, proof: true, arguments: [], 'result-type': { 'type-name': 'Tuple', types: [] } },
        { name: 'view', pure: true, proof: false, arguments: [{ name: 'x', type: { 'type-name': 'Uint' } }], 'result-type': { 'type-name': 'Uint' } },
      ],
      witnesses: [],
    });
    expect(out).toContain('Contract: counter');
    expect(out).toContain('impure increment()');
    expect(out).toContain('pure   view(x: Uint)');
  });

  it('omits witnesses section when none declared', () => {
    const out = renderContractSummary({ name: 'x', circuits: [], witnesses: [] });
    expect(out).not.toContain('Witnesses');
  });

  it('lists witnesses when present', () => {
    const out = renderContractSummary({
      name: 'bboard',
      circuits: [],
      witnesses: [{ name: 'localSecretKey', arguments: [] }],
    });
    expect(out).toContain('Witnesses:');
    expect(out).toContain('localSecretKey()');
  });
});

describe('buildCliPrompt', () => {
  it('embeds contract name, target circuit, and goal', () => {
    const prompt = buildCliPrompt({
      contractName: 'counter',
      contractSummary: 'Contract: counter\n…',
      targetCircuit: incrementCircuit,
      goal: 'round goes from 0 to 1 after increment',
    });
    expect(prompt).toContain('counter');
    expect(prompt).toContain('increment');
    expect(prompt).toContain('round goes from 0 to 1 after increment');
    expect(prompt).toContain(RESPONSE_FENCE);
  });

  it('handles a circuit with no goal — instructs the model to infer one', () => {
    const prompt = buildCliPrompt({
      contractName: 'counter',
      contractSummary: 'Contract: counter',
      targetCircuit: incrementCircuit,
    });
    expect(prompt).toContain('No specific success criterion');
  });

  it('inlines contract source when given', () => {
    const prompt = buildCliPrompt({
      contractName: 'counter',
      contractSummary: 'Contract: counter',
      contractSource: 'export ledger round: Counter;\nexport circuit increment(): [] {}',
      targetCircuit: incrementCircuit,
    });
    expect(prompt).toContain('export ledger round: Counter');
  });
});

describe('buildUiPrompt', () => {
  it('embeds screen name, source, url, and goal', () => {
    const prompt = buildUiPrompt({
      contractName: 'zkloan',
      contractSummary: 'Contract: zkloan',
      screenComponent: 'LoanRequestForm',
      screenSource: 'export const LoanRequestForm = () => <button>Request loan →</button>',
      url: 'http://localhost:4173/',
      goal: 'a new approved loan appears',
    });
    expect(prompt).toContain('zkloan');
    expect(prompt).toContain('LoanRequestForm');
    expect(prompt).toContain('Request loan →');
    expect(prompt).toContain('http://localhost:4173/');
    expect(prompt).toContain('a new approved loan appears');
    expect(prompt).toContain(RESPONSE_FENCE);
  });

  it('appends related sources when provided', () => {
    const prompt = buildUiPrompt({
      contractName: 'x',
      contractSummary: 's',
      screenComponent: 'Foo',
      screenSource: '...',
      url: 'http://l/',
      relatedSources: [{ path: 'src/Header.tsx', source: 'export const Header = () => null;' }],
    });
    expect(prompt).toContain('src/Header.tsx');
    expect(prompt).toContain('export const Header');
  });
});

// ── End-to-end orchestration with stubbed runner ──

function fenced(json: unknown): string {
  return '```json\n' + JSON.stringify(json) + '\n```';
}

describe('generateCliScaffoldWithAI', () => {
  it('builds a ScaffoldOutput from a valid AI response', async () => {
    const runner = async () => fenced({
      description: 'Increments the counter and verifies round becomes 1',
      actions: {
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'check-zero', type: 'contract-state', assert: { round: { '==': 0 } } },
          { id: 'do-it', type: 'contract-call', circuit: 'increment' },
          { id: 'check-one', type: 'contract-state', assert: { round: { '==': 1 } } },
        ],
      },
      assertions: { post: [{ id: 'serve-port-listening', type: 'port-listening', params: { port: 9932 }, expect: 'pass' }] },
    });

    const out = await generateCliScaffoldWithAI(
      { contract: counterContract, targetCircuit: incrementCircuit },
      runner,
    );

    expect(out.suite.strategy).toBe('cli');
    expect(out.suite.description).toContain('Increments the counter');
    expect(out.suiteName).toBe('cli-increment');
    expect(out.actions).not.toBeNull();
    expect(out.actions?.actions).toHaveLength(4);
    expect(out.prompt).toBeNull();
  });

  it('rejects responses that reference unknown circuits', async () => {
    const runner = async () => fenced({
      description: 'bad',
      actions: { actions: [{ id: 'x', type: 'contract-call', circuit: 'doesNotExist' }] },
      assertions: { post: [] },
    });

    await expect(
      generateCliScaffoldWithAI({ contract: counterContract, targetCircuit: incrementCircuit }, runner),
    ).rejects.toThrow(/unknown circuit "doesNotExist"/);
  });

  it('rejects responses without a JSON fence', async () => {
    const runner = async () => 'Sure, here is the suite: actions = [...]';
    await expect(
      generateCliScaffoldWithAI({ contract: counterContract, targetCircuit: incrementCircuit }, runner),
    ).rejects.toThrow(/fenced block/);
  });

  it('rejects malformed JSON inside the fence', async () => {
    const runner = async () => '```json\n{ this is not json\n```';
    await expect(
      generateCliScaffoldWithAI({ contract: counterContract, targetCircuit: incrementCircuit }, runner),
    ).rejects.toThrow(/JSON inside the fence failed/);
  });

  it('auto-adds port-listening assertion when the model omits it', async () => {
    const runner = async () => fenced({
      description: 'd',
      actions: { actions: [{ id: 'deploy', type: 'contract-deploy' }] },
      assertions: { post: [] },
    });
    const out = await generateCliScaffoldWithAI(
      { contract: counterContract, targetCircuit: incrementCircuit },
      runner,
    );
    expect(out.assertions.post).toContainEqual(
      expect.objectContaining({ type: 'port-listening', params: { port: 9932 } }),
    );
  });

  it('accepts top-level `actions: [...]` (the shape Claude tends to emit naturally)', async () => {
    // Same content as the wrapped form, but flatter — what Claude returns
    // by default before reading the schema-locked prompt block.
    const runner = async () => fenced({
      description: 'flat shape',
      actions: [
        { id: 'deploy', type: 'contract-deploy' },
        { id: 'check', type: 'contract-state', assert: { round: { '==': 0 } } },
      ],
      assertions: { post: [] },
    });
    const out = await generateCliScaffoldWithAI(
      { contract: counterContract, targetCircuit: incrementCircuit },
      runner,
    );
    expect(out.actions).not.toBeNull();
    expect(out.actions?.actions).toHaveLength(2);
    expect(out.actions?.actions[0]).toMatchObject({ id: 'deploy' });
  });

  it('still rejects when actions is missing entirely', async () => {
    const runner = async () => fenced({
      description: 'd',
      assertions: { post: [] },
    });
    await expect(
      generateCliScaffoldWithAI({ contract: counterContract, targetCircuit: incrementCircuit }, runner),
    ).rejects.toThrow(/missing actions/);
  });

  // ── arg-shape validation ──

  describe('arg-shape validation against contract-info', () => {
    const zkloanLikeContract: ContractInfo = {
      name: 'zkloan',
      managedDir: '/tmp/m',
      compilerVersion: '0.30.0',
      languageVersion: '0.22.0',
      runtimeVersion: '0.15.0',
      siblings: [],
      circuits: [
        {
          name: 'registerProvider',
          pure: false,
          proof: true,
          arguments: [
            { name: 'providerId', type: { 'type-name': 'Uint', maxval: 65535 } },
            { name: 'providerPk', type: { 'type-name': 'Struct' } },
          ],
          'result-type': { 'type-name': 'Tuple', types: [] },
        },
      ],
      witnesses: [],
    };

    const validCall = {
      id: 'register',
      type: 'contract-call',
      circuit: 'registerProvider',
      args: { providerId: 1, providerPk: { x: '1n', y: '2n' } },
    };

    it('passes when every required arg is present and well-typed', async () => {
      const runner = async () => fenced({
        description: 'ok',
        actions: [{ id: 'deploy', type: 'contract-deploy' }, validCall],
        assertions: { post: [] },
      });
      const out = await generateCliScaffoldWithAI(
        { contract: zkloanLikeContract, targetCircuit: zkloanLikeContract.circuits[0] },
        runner,
      );
      expect(out.actions?.actions).toHaveLength(2);
    });

    it('rejects when a required arg key is missing', async () => {
      const runner = async () => fenced({
        description: 'bad',
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'reg', type: 'contract-call', circuit: 'registerProvider', args: { providerId: 1 } }, // missing providerPk
        ],
        assertions: { post: [] },
      });
      await expect(
        generateCliScaffoldWithAI(
          { contract: zkloanLikeContract, targetCircuit: zkloanLikeContract.circuits[0] },
          runner,
        ),
      ).rejects.toThrow(/missing required arg "providerPk"/);
    });

    it('rejects when a Struct-typed arg is a primitive', async () => {
      const runner = async () => fenced({
        description: 'bad',
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'reg', type: 'contract-call', circuit: 'registerProvider', args: { providerId: 1, providerPk: 42 } },
        ],
        assertions: { post: [] },
      });
      await expect(
        generateCliScaffoldWithAI(
          { contract: zkloanLikeContract, targetCircuit: zkloanLikeContract.circuits[0] },
          runner,
        ),
      ).rejects.toThrow(/arg "providerPk" must be an object for Struct/);
    });

    it('rejects when a Struct-typed arg is null (the actual zkloan failure shape)', async () => {
      const runner = async () => fenced({
        description: 'bad',
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'reg', type: 'contract-call', circuit: 'registerProvider', args: { providerId: 1, providerPk: null } },
        ],
        assertions: { post: [] },
      });
      await expect(
        generateCliScaffoldWithAI(
          { contract: zkloanLikeContract, targetCircuit: zkloanLikeContract.circuits[0] },
          runner,
        ),
      ).rejects.toThrow(/arg "providerPk" must be an object for Struct/);
    });

    it('rejects when a Struct-typed arg is an array', async () => {
      const runner = async () => fenced({
        description: 'bad',
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'reg', type: 'contract-call', circuit: 'registerProvider', args: { providerId: 1, providerPk: ['x', 'y'] } },
        ],
        assertions: { post: [] },
      });
      await expect(
        generateCliScaffoldWithAI(
          { contract: zkloanLikeContract, targetCircuit: zkloanLikeContract.circuits[0] },
          runner,
        ),
      ).rejects.toThrow(/arg "providerPk" must be an object for Struct/);
    });

    it('passes a no-arg circuit through without args', async () => {
      const noArgContract: ContractInfo = {
        ...zkloanLikeContract,
        circuits: [{
          name: 'reset', pure: false, proof: true, arguments: [],
          'result-type': { 'type-name': 'Tuple', types: [] },
        }],
      };
      const runner = async () => fenced({
        description: 'ok',
        actions: [
          { id: 'deploy', type: 'contract-deploy' },
          { id: 'reset', type: 'contract-call', circuit: 'reset' }, // no args
        ],
        assertions: { post: [] },
      });
      const out = await generateCliScaffoldWithAI(
        { contract: noArgContract, targetCircuit: noArgContract.circuits[0] },
        runner,
      );
      expect(out.actions?.actions).toHaveLength(2);
    });
  });
});

describe('generateUiScaffoldWithAI', () => {
  // Use the file we created in the discover-screens test fixture pattern. For
  // this unit test we stub the screen path with a real existing file: ours.
  const screen: ScreenCandidate = {
    name: 'wallet-cli-bootstrap',
    component: 'WalletCliBootstrap',
    path: import.meta.dirname + '/../lib/test/ai-prompts.ts', // any real file
    relativePath: 'src/lib/test/ai-prompts.ts',
  };

  it('builds a browser ScaffoldOutput from a valid AI response', async () => {
    const runner = async () => fenced({
      description: 'Tests the loan request flow end to end',
      prompt: 'Open http://l/ and click Request loan',
      assertions: {
        post: [
          { id: 'claude-exit-ok', type: 'process-exit-code', params: { code: 0 }, expect: 'pass' },
          { id: 'serve-port-listening', type: 'port-listening', params: { port: 9932 }, expect: 'pass' },
        ],
      },
    });

    const out = await generateUiScaffoldWithAI(
      {
        contract: counterContract,
        screen,
        url: 'http://localhost:4173/',
        port: 4173,
        buildCmd: 'npm run dev',
      },
      runner,
    );

    expect(out.suite.strategy).toBe('browser');
    expect(out.suite.description).toContain('loan request');
    expect(out.suiteName).toBe('ui-wallet-cli-bootstrap');
    expect(out.prompt).toContain('Open http://l/');
    expect(out.actions).toBeNull();
  });

  it('auto-adds claude-exit-ok and port-listening when the model omits them', async () => {
    const runner = async () => fenced({
      description: 'minimal',
      prompt: 'open the page',
      assertions: { post: [] },
    });
    const out = await generateUiScaffoldWithAI(
      {
        contract: counterContract,
        screen,
        url: 'http://localhost:4173/',
        port: 4173,
        buildCmd: 'npm run dev',
      },
      runner,
    );
    const ids = out.assertions.post.map((a) => a.id);
    expect(ids).toContain('claude-exit-ok');
    expect(ids).toContain('serve-port-listening');
  });

  it('rejects responses missing a non-empty prompt', async () => {
    const runner = async () => fenced({ description: 'd', prompt: '   ', assertions: { post: [] } });
    await expect(
      generateUiScaffoldWithAI(
        { contract: counterContract, screen, url: 'http://l/', port: 4173, buildCmd: 'x' },
        runner,
      ),
    ).rejects.toThrow(/non-empty `prompt`/);
  });

  it('works without a screen — generic Midnight dApp flow keyed off goal', async () => {
    let receivedPrompt = '';
    const runner = async (p: string) => {
      receivedPrompt = p;
      return fenced({
        description: 'happy path: connect, deploy, increment, verify',
        prompt: '1. open URL\n2. click Connect Wallet\n3. ...',
        assertions: { post: [] },
      });
    };

    const out = await generateUiScaffoldWithAI(
      {
        contract: counterContract,
        url: 'http://localhost:4173/',
        port: 4173,
        buildCmd: 'npm run dev',
        goal: 'happy path',
      },
      runner,
    );

    // Suite name derives from the goal slug when no screen is given.
    expect(out.suiteName).toBe('ui-happy-path');
    // Prompt sent to Claude should mention the no-screen mode hints.
    expect(receivedPrompt).toContain('No specific screen was selected');
    expect(receivedPrompt).toContain('Conventional patterns Midnight dApps follow');
    expect(receivedPrompt).toContain('happy path');
  });

  it('falls back to ui-ai when neither screen nor goal slug is usable', async () => {
    const runner = async () => fenced({
      description: 'd', prompt: 'open ' + 'http://l/', assertions: { post: [] },
    });
    const out = await generateUiScaffoldWithAI(
      { contract: counterContract, url: 'http://l/', port: 4173, buildCmd: 'x' },
      runner,
    );
    expect(out.suiteName).toBe('ui-ai');
  });
});
