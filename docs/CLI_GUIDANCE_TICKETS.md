# CLI Guidance Tickets

Ranked, actionable in-CLI improvements surfaced by the beginner journey
(see `BEGINNER_JOURNEY.md` for the narrative).

Each ticket captures:
- **Where:** the moment of confusion
- **What `mn` did:** current behavior
- **What `mn` should have done:** proposed behavior
- **Effort:** S (under an hour), M (a day), L (multi-day)

---

## Ticket 1: First-run welcome

**Where:** `mn` invoked with no args, or in an empty dir for the first time.
**What `mn` did:** print the command list, no welcome.
**What `mn` should do:** detect first run (no config file in `~/.midnight/`)
and print a 5-line welcome: "First time? Run `mn quickstart` to scaffold
a project. Or `mn help --agent` to load the full reference into your AI
assistant." After first run, drop the welcome.
**Effort:** S.

---

## Ticket 2: `mn init` scaffolder

**Where:** before the user has any project files.
**What `mn` did:** nothing. Beginner has to find an example dApp and
copy from it.
**What `mn` should do:** `mn init [name]` creates a starter project with:
`package.json` (right deps), `src/counter.compact` (minimal example),
`src/witnesses.ts` (vacant + commented stub), `tsconfig.json`,
`scripts: { compact, build, test }`. Optionally a `--template` flag for
counter, token, marketplace, etc.
**Effort:** M.

---

## Ticket 3: Errors should explain prerequisites

**Where:** `mn contract inspect` says "Run `compact compile` first".
**What `mn` did:** assumed the user knows what `compact` is.
**What `mn` should do:** when an error references an external tool,
include "If you don't have `compact` installed, see:
https://docs.midnight.network/develop/tutorial/building/compactc"
or similar. Detect missing tool with `which compact` and bump the
suggestion when not found.
**Effort:** S.

---

## Ticket 5: Detect missing/broken Compact toolchain

**Where:** before any `mn dev` or `mn contract` operation.
**What `mn` did:** assumes `compact` and `compactc` are wired correctly.
**What `mn` should do:** on first run, check `compact list` shows an
installed version, and probe `~/.compact/bin/compactc --version`. If
either fails, print actionable next steps: "install Compact toolchain
via https://docs.midnight.network/develop/tutorial/building/compactc"
or "your shim is broken; reinstall via `compact update`."
**Effort:** S.

---

## Ticket 6: `mn init --template counter` ships the contract starter

**Where:** see Ticket 2. This is the same need but more specific.
**What `mn` should do:** the `mn init` scaffolder includes
`src/<name>.compact` with the right pragma and `import
CompactStandardLibrary`. Beginner never has to discover the magic
preamble.
**Effort:** rolled into Ticket 2.

---

## Ticket 7: Document deploy dep list (or, better, hide it)

**Where:** when a beginner reads about `mn contract deploy` and wants
to know what their `package.json` needs.
**What `mn` did:** until CLI_FEEDBACK #1, the answer was "install 11
SDK packages." Now NODE_PATH bundles them, so the answer is "nothing"
in most cases. But the beginner doesn't know that.
**What `mn` should do:** `mn contract deploy --explain-deps` prints
"deploys use the SDK bundled with `mn` via NODE_PATH. Your project
needs no `@midnight-ntwrk/*` deps unless you want to pin a specific
version." Or, fold into `mn doctor` (a future health-check command).
**Effort:** S.

---

## Ticket 8: CI smoke test for `mn contract deploy`

**Where:** the gap that let CLI_FEEDBACK #1 ship broken.
**What `mn` did:** the fix was committed without an end-to-end test
that actually runs a deploy. The reviewer (me) approved it on a
typecheck pass. Real deployment was never exercised in CI.
**What we should do:** add a smoke test to the test suite that:
spins up localnet, scaffolds a counter (or uses a fixture), runs
`mn contract deploy --network undeployed`, asserts an address
came back, runs `mn contract call`, asserts state changed. Gated
by an env var (`MN_E2E=1`) so it doesn't slow the default suite.
Even better: run it in CI nightly against a fresh container.
**Effort:** M.

---

## Ticket 9: Quiet the deploy spinner

**Where:** `mn contract deploy` non-JSON mode.
**What `mn` did:** repaints the spinner ~270 times for a single
deploy. Each repaint emits a fresh `⠋ Deploying contract...` line
with `[K` clear-to-EOL. Looks fine in a real terminal but explodes
when captured.
**What `mn` should do:** detect non-TTY stderr (`!process.stderr.isTTY`)
and substitute a quiet progress reporter that prints one line per
state change ("Deploying...", "Submitted (txHash=...)", "Mined").
The spinner stays for humans, the noise dies for everyone else.
**Effort:** S.

---

## Ticket 10: Suggest next steps after a successful deploy

**Where:** end of `mn contract deploy` non-JSON output.
**What `mn` did:** print the address, exit.
**What `mn` should do:** add a 2-line "next steps" hint:
"Try: `mn contract state --address <X>` to inspect ledger state,
`mn contract call --address <X> --circuit <name>` to invoke a
circuit." Generates from the contract's known circuits (already
have them via `findContractInfo`).
**Effort:** S.

---

## Ticket 11: Validate fixes end-to-end before claiming "fixed"

**Where:** the working culture, not the CLI itself.
**What we did:** shipped CLI_FEEDBACK #1 with a commit message that
overpromised. Both halves of the fix (bundling, NODE_PATH) were
broken, but typecheck passed and we moved on.
**What we should do:** for any fix to a "deploy" or "call" path,
require a manual smoke test against a real contract (Ticket 8 makes
this automatic). For any fix that touches Node module resolution,
require the assertion "I ran the failing user's exact command and
it now succeeds." Add to PR template.
**Effort:** S (process change) + M (PR template + checklist).

---

## Ticket 12: Network-switch is invisible

**Where:** end of a successful undeployed deploy.
**What `mn` did:** print address, exit.
**What `mn` should do:** add a hint: "Same artifact deploys to other
networks. Try `mn contract deploy --network preprod` (requires a
funded preprod wallet) or `--network preview`." Drives home that
contracts are network-portable without code changes.
**Effort:** S.

---

## Ticket 13: Surface cache wins so users know to trust them

**Where:** preprod deploy/balance/transfer when WalletDataRepository
hits the cache.
**What `mn` did:** silently restored from disk in ~4s instead of the
~3min cold sync.
**What `mn` should do:** on first cache hit per session, print a
one-liner: "Resumed from cache (4s vs ~3min cold). State will be
re-validated against chain tip." Tells the user "yes this is real,
no it's not a stale read." Fades after a few uses.
**Effort:** S.

---

## Ticket 4: Advertise `--agent` to humans, not just AIs

**Where:** bottom line of `mn help`.
**What `mn` did:** "midnight help --agent   AI & MCP reference" reads as
an AI-only thing.
**What `mn` should do:** rephrase as "Working with Claude/Cursor? Run
`mn help --agent` to give your AI assistant the full reference." Makes
clear the human is the audience, the AI is the consumer.
**Effort:** S.

---

