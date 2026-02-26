# midnight-wallet-cli

A standalone git-style CLI wallet for the Midnight blockchain.

## Workflow Orchestration

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management

1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Engineering Standards

### Modularity
- Single responsibility per file — one module, one concern
- Shared logic lives in `src/lib/`, never duplicated across commands
- Every command imports from lib/ui — no inline network configs, no inline formatting
- If you write the same pattern twice, extract it

### Interfaces & Boundaries
- Define clear interfaces between layers: commands → lib → SDK
- Commands handle argv parsing and output — nothing else
- Lib modules are pure logic — no process.exit(), no console output (return values or throw)
- UI modules own all terminal formatting — commands call them, never raw console.log

### Error Handling
- Errors are typed and meaningful — no generic "Something went wrong"
- Throw from lib, catch and format in commands
- Every user-facing error includes what went wrong and what to do about it

### Naming & Consistency
- Functions describe what they do: `loadWalletConfig`, not `getConfig`
- Files match their primary export
- Consistent patterns across all commands: same arg parsing style, same output structure

### Testing
- Unit test every lib module — these are pure functions, no excuses
- Tests live in `src/__tests__/` mirroring the source structure
- Test runner: vitest
- Test what the module does, not how it does it — assert on return values and thrown errors
- No mocks of our own code — if you need to mock it, the boundary is wrong
- SDK/external dependencies may be stubbed at the interface boundary when needed for isolation
- Every bug fix comes with a regression test

### Dependencies
- Minimize external dependencies — use what the SDK provides
- Wrap third-party APIs behind our own interfaces so they're swappable
- No transitive dependency leaking into command files

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
- **No Mocks**: No mocks, no todos (unless explicitly approved), no cheating.
- **No Assumptions**: Read all necessary files before making changes. Ask when unclear.
- **No Unauthorized Changes**: Don't change dependencies, delete code, or change direction without approval.

## Tech Stack

- **Language**: TypeScript, run via `tsx`
- **Runtime**: Node.js (>=20)
- **CLI parsing**: Manual `process.argv` — NO commander, yargs, or similar
- **Terminal UI**: Node.js native `readline` — NO inquirer, prompts, or similar
- **Colors**: Raw ANSI escape codes — NO chalk, kleur, or similar
- **Package manager**: npm

## Reference Implementation

Patterns extracted from `/Users/norman/Development/midnight/kuira-verification-test/scripts/`. Read those files for SDK patterns (WalletFacade, HD derivation, dust registration, GraphQL subscriptions). See `DESIGN.md` for architecture and command specs.

### Technical Context

- Midnight libraries: `/Users/norman/Development/midnight/midnight-libraries`
- Compact language: `/Users/norman/Development/midnight/midnight-libraries/compact`
- Wallet SDK: `/Users/norman/Development/midnight/midnight-libraries/midnight-wallet`
- Dapp connector: `/Users/norman/Development/midnight/midnight-libraries/midnight-dapp-connector-api`

