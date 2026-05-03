// Prompt templates for AI-assisted test scaffolding. The shape of these
// strings is the API between us and Claude — change them carefully and
// keep snapshot tests in sync.
//
// Both prompts ask Claude for a structured JSON response wrapped in a
// ```json fence. The orchestrator extracts and validates that fence
// against our schemas; a malformed response triggers fallback to the
// deterministic scaffolder.

import type { CircuitInfo } from '../contract/inspect.ts';

// ── Shared ─────────────────────────────────────────────────────────

/**
 * The fence marker the runner looks for in Claude's response. Putting it
 * in one constant prevents drift between the prompt instructions and the
 * parser. Keep this exact string ("```json" + newline) in the regex too.
 */
export const RESPONSE_FENCE = '```json';

const COMMON_RULES = `\
Output rules:
- Reply with EXACTLY one ${RESPONSE_FENCE} ... \`\`\` fenced code block.
- Inside the fence: valid JSON, nothing else (no comments, no trailing text).
- Fields you don't know about: omit them. Don't invent fields.
- Use only the circuit / ledger field names that appear in the inputs below.
- Be concise — fewer, well-named actions beat many vague ones.`;

// ── CLI strategy prompt ────────────────────────────────────────────

export interface CliPromptInputs {
  contractName: string;
  /** Short summary of the contract — name, ledger fields, witnesses, all circuits with arg/return types. */
  contractSummary: string;
  /** Full .compact source if available. May be omitted (e.g. precompiled deps); the model still uses contractSummary. */
  contractSource?: string;
  /** The specific circuit the user wants to focus this suite on. */
  targetCircuit: CircuitInfo;
  /** One-line success criterion from the user, or undefined. */
  goal?: string;
}

/**
 * Build the prompt that asks Claude to scaffold a focused CLI test suite
 * for one circuit. Output JSON shape matches our TestActions / TestAssertions
 * types: { actions: [...], assertions: { post: [...] } }.
 */
export function buildCliPrompt(inputs: CliPromptInputs): string {
  const { contractName, contractSummary, contractSource, targetCircuit, goal } = inputs;
  const circuitName = targetCircuit.name;
  const argSummary = targetCircuit.arguments.length === 0
    ? '(takes no arguments)'
    : targetCircuit.arguments.map((a) => `  - ${a.name}: ${a.type['type-name']}`).join('\n');

  return `\
You are scaffolding a CLI test suite for the Midnight contract \`${contractName}\`.
Strategy is "cli" — no browser. The test will run via \`mn test run\`, which
deploys the contract, executes the actions in order, and asserts on the
final ledger state.

## Target

Focus this suite on ONE circuit:

  Circuit: ${circuitName} (${targetCircuit.pure ? 'pure' : 'impure'})
  Args:
${argSummary}

${goal ? `Success criterion (from the user):\n  > ${goal}\n` : 'No specific success criterion was given. Pick a reasonable one and reflect it in the suite description.\n'}

## Contract context

${contractSummary}

${contractSource ? `\n--- contract source ---\n${contractSource}\n--- end source ---\n` : ''}

## What to produce

A JSON object with three keys:

  - actions: ordered list. Always start with { "id": "deploy", "type": "contract-deploy" }.
             For circuits that need prior state (e.g. registerProvider before
             requestLoan), include the setup actions explicitly. End with
             a contract-state read so the assertion can run on the result.
  - assertions: { "post": [ { id, type, params, expect } ] }. Use type
                "port-listening" with params { "port": 9932 } as a baseline
                and add others if they make sense.
  - description: one short sentence summarising what this suite verifies.

Action shape:
  { "id": "<short-slug>", "type": "contract-deploy" }
  { "id": "<short-slug>", "type": "contract-state", "assert": { "<fieldOrMap>": { "<op>": <value> } } }
  { "id": "<short-slug>", "type": "contract-call", "circuit": "<name>", "args": { ... } }

Args coercion the runner applies (so JSON arg values can be):
  - number → BigInt for Uint<N>
  - "123n" string → BigInt for values beyond Number.MAX_SAFE_INTEGER
  - [0..255] int array → Uint8Array for Bytes<N>
  - object → recurses into Struct fields

${COMMON_RULES}

Now produce the JSON.`;
}

// ── UI / browser strategy prompt ───────────────────────────────────

export interface UiPromptInputs {
  contractName: string;
  /** Same shape as CLI: name, ledger, circuits, witnesses. */
  contractSummary: string;
  /** Display name of the screen the user picked (PascalCase component name).
   *  Optional — when omitted, the prompt asks Claude to generate a generic
   *  Midnight dApp flow grounded in the contract + the goal. */
  screenComponent?: string;
  /** Source of the screen's React component file. Used so the prompt
   *  references real button labels / element text rather than guesses.
   *  Optional — see screenComponent. */
  screenSource?: string;
  /** Optional sources of imported components from the same UI tree —
   *  helps Claude name nested elements (e.g. nested "Submit" buttons).
   *  Keep this small to control token cost. */
  relatedSources?: { path: string; source: string }[];
  /** URL the dApp is served on during the test (from dapp.test.json). */
  url: string;
  /** Optional one-line success criterion from the user. */
  goal?: string;
}

/**
 * Build the prompt that asks Claude to scaffold a focused browser test
 * suite. Output JSON shape: { prompt, assertions, description }.
 * Note: no "actions" key — browser strategy uses prompt.md to drive the UI.
 *
 * Two modes depending on whether `screenComponent`/`screenSource` were
 * given:
 * - Screen-grounded: Claude reads the actual JSX so generated steps
 *   reference real on-screen labels.
 * - Goal-only: Claude generates a generic Midnight dApp flow grounded
 *   in the contract circuits + the user's goal. Less precise, but
 *   useful when the user knows what they want to test ("happy path")
 *   without pointing at a specific component.
 */
export function buildUiPrompt(inputs: UiPromptInputs): string {
  const { contractName, contractSummary, screenComponent, screenSource, relatedSources, url, goal } = inputs;

  const related = (relatedSources ?? [])
    .map((r) => `\n--- ${r.path} ---\n${r.source}\n--- end ${r.path} ---`)
    .join('\n');

  const screenSection = screenComponent && screenSource
    ? `\
## Target screen

Component: ${screenComponent}
Served at: ${url}

## Screen source

\`\`\`tsx
${screenSource}
\`\`\`
${related ? `\n## Imported components from the same UI\n${related}\n` : ''}`
    : `\
## Target

No specific screen was selected — generate a generic Midnight dApp
flow grounded in the contract circuits + the user's goal below.
The dApp is served at ${url}.

Conventional patterns Midnight dApps follow that you can rely on:
- A "Connect Wallet" button in the header.
- After connect, a contract-address paste field labelled near
  "Contract address" with a "Connect →" or "Link" action.
- Per-circuit forms with a labelled "Submit" / "Send" / "Run" action
  and progress feedback during ZK proof generation (30–90 s).
- A history / state panel that updates after a successful tx.
- Toast or inline error messages on failure.

Use generic-but-specific selectors (\`getByRole('button', { name: /connect wallet/i })\`)
in the prompt steps, since you don't have the actual JSX.`;

  const goalSection = goal
    ? `Success criterion (from the user):\n  > ${goal}\n`
    : screenComponent
      ? 'No specific success criterion was given. Infer one from the screen source: what is the obvious "happy path" outcome a user would see on success?\n'
      : 'No specific success criterion was given. Infer one from the contract circuits: what is the obvious "happy path" outcome the dApp exists to support?\n';

  return `\
You are scaffolding a browser test for the Midnight dApp \`${contractName}\`.
The test runs via \`mn test run\` — Claude (you, in the test session)
drives Chrome and follows a prompt.md file.

${screenSection}

${goalSection}

## Contract context (so you know what circuits the dApp calls)

${contractSummary}

## What to produce

A JSON object with three keys:

  - prompt: the markdown body of prompt.md the test runner will hand to
            Claude in the actual test session. Numbered steps, terse.
            ${screenSource
              ? 'CRITICAL: reference the EXACT button labels and field labels that appear in the source above ("Save PIN", "Request loan →", etc.). Don\'t invent labels.'
              : 'Use the conventional Midnight dApp patterns above. The test session\'s Claude will adapt to the dApp\'s actual labels.'}
            Steps should:
              1. open ${url} in Chrome
              2. wait for any wallet/connection state the dApp needs
              3. perform the on-screen actions for the goal
              4. verify the success criterion on screen
              5. report pass/fail per step + final on-screen text
            Keep it under 25 lines.
  - assertions: { "post": [ ... ] } — at minimum
                { "id": "claude-exit-ok", "type": "process-exit-code",
                  "params": { "code": 0 }, "expect": "pass" },
                { "id": "serve-port-listening", "type": "port-listening",
                  "params": { "port": 9932 }, "expect": "pass" },
                and
                { "id": "agent-no-failure", "type": "agent-report-no-failure",
                  "params": {}, "expect": "pass" }
                (this last one parses your final report — without it, you
                writing "FAILED" still counts as a pass).
                Add others if the success state can be checked from the
                chain (e.g. ledger-field on a contract-state read).
  - description: one short sentence summarising what this suite verifies.

${COMMON_RULES}

Now produce the JSON.`;
}

// ── Helpers callers might use to build contractSummary ─────────────

/**
 * Render a contract's circuits/witnesses into a compact, readable summary.
 * Used as the `contractSummary` input for both prompt builders. Keeping
 * this here (vs in the orchestrator) so the prompt-shape evolves alongside
 * the renderer.
 */
export function renderContractSummary(args: {
  name: string;
  circuits: CircuitInfo[];
  witnesses: { name: string; arguments: { name: string; type: { 'type-name': string } }[] }[];
}): string {
  const { name, circuits, witnesses } = args;
  const lines: string[] = [`Contract: ${name}`];

  if (circuits.length > 0) {
    lines.push('', 'Circuits:');
    for (const c of circuits) {
      const args = c.arguments.length === 0
        ? '()'
        : '(' + c.arguments.map((a) => `${a.name}: ${a.type['type-name']}`).join(', ') + ')';
      lines.push(`  ${c.pure ? 'pure  ' : 'impure'} ${c.name}${args}`);
    }
  }

  if (witnesses.length > 0) {
    lines.push('', 'Witnesses:');
    for (const w of witnesses) {
      const args = w.arguments.length === 0
        ? '()'
        : '(' + w.arguments.map((a) => `${a.name}: ${a.type['type-name']}`).join(', ') + ')';
      lines.push(`  ${w.name}${args}`);
    }
  }

  return lines.join('\n');
}
