# Contributing to midnight-wallet-cli

Thanks for your interest. This is an open project and contributions are welcome
— bug reports, fixes, new features, docs improvements, and feedback on the
agent-facing surface (MCP, `--json`, `--agent` flag).

## Getting set up

```bash
git clone https://github.com/nel349/midnight-wallet-cli.git
cd midnight-wallet-cli
npm install
```

You also need:

- **Node.js >= 20**
- **Docker** — for `mn localnet` integration testing
- **A proof server** at `localhost:6300` if you're testing transactions
  (`mn localnet up` provides one)

## The dev loop

```bash
# Run the CLI from source (no rebuild needed)
npx tsx src/wallet.ts <command>

# Run the MCP server from source
npx tsx src/mcp-server.ts

# Build the production bundles (dist/wallet.js + dist/mcp-server.js)
npm run build

# Type-check
npm run typecheck

# Tests
npm test           # one-shot
npm run test:watch # vitest watch mode
```

The tests live in `src/__tests__/`. They run against real interfaces — no mocks
of our own code (per the project's testing standards in CLAUDE.md). External
SDK boundaries may be stubbed when needed for isolation.

## Project layout

```
src/
  commands/      One file per top-level command (wallet.ts, contract.ts, ...)
  lib/           Pure logic — no console, no process.exit; throws + returns
  ui/            Terminal output: colors, spinner, format helpers
  __tests__/     Unit tests, mirrors the source structure
  wallet.ts      CLI entry point
  mcp-server.ts  MCP server entry point
docs/
  SKILL.md       Agent reference (loaded as MCP resource)
  SKILL-CORE.md  Slim agent reference for session start
```

Read `CLAUDE.md` at the repo root for the full engineering standards
(modularity, error handling, naming, testing conventions).

## Pull request workflow

1. **Open an issue first** for non-trivial changes so we can align on the
   approach before you write code.
2. **Branch from `main`.** Keep PRs focused — one logical change per PR.
3. **Write or update tests.** Every bug fix needs a regression test; every
   new feature needs unit tests in `src/__tests__/`.
4. **Run the full check before pushing:**
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
5. **Commit messages** follow the repo style (look at `git log` for examples):
   ```
   feat(scope): short imperative summary
   fix(scope): short imperative summary
   docs(scope): ...
   refactor(scope): ...
   chore(scope): ...
   ```
   Keep the subject line under ~72 chars. Add a body if the why isn't
   obvious from the diff.
6. **Open the PR** with a clear description: what changed, why, and how to
   verify. Link the related issue.

## Code standards (the short version)

- **TypeScript everywhere.** Run via `tsx`, no transpile step in dev.
- **No new dependencies** without discussion. The CLI deliberately uses
  Node's native `readline` (not inquirer), raw ANSI codes (not chalk),
  and manual argv parsing (not commander/yargs).
- **Single responsibility per file.** Commands parse args + format output;
  pure logic lives in `src/lib/`; UI lives in `src/ui/`.
- **No mocks of our own code.** If you need to mock it, the boundary is
  wrong — refactor instead.
- **Errors are typed and meaningful.** Throw from `lib/`, catch and format
  in `commands/`. Every user-facing error includes what went wrong AND what
  to do about it.
- **Don't break the agent surface.** `--json`, `--agent`, and the MCP tool
  shapes are an API. If you change them, update `docs/SKILL.md` and bump
  the version note.

## Reporting bugs

[Open an issue](https://github.com/nel349/midnight-wallet-cli/issues) with:

- What you ran
- What you expected
- What actually happened (include stderr — it carries the chrome)
- Output of `mn --version` and `node --version`
- Network (`undeployed` / `preprod` / `preview`) and whether localnet is up

For agent / MCP issues, include the MCP client (Claude Code, Cursor, etc.)
and the response with `_serverVersion` so we can rule out stale installs.

## License

By contributing, you agree that your contributions will be licensed under
the [Apache License 2.0](LICENSE).
