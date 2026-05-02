# v0.4 Release Video Script

Two production formats. Pick one based on event timeline.

- **Format A**: silent commercial, two pane layout, animated text overlays only.
  Reference: Anthropic Claude Code clips. About 18 seconds runtime.
- **Format B**: voiced walkthrough with live demo. About 6 to 7 minutes runtime.

---

## Audience

Developers building Compact dApps on Midnight, plus AI agents helping them.
Pitches `mn` as the one CLI that covers wallets, contract deployment, and the
development loop, with stable JSON output and stable MCP tools so agents can
chain commands without glue code.

Ground rules:

- No reference to other Midnight ecosystem plugins.
- No talking head in Format A.
- All commands shown must actually run.

---

## Format A, silent commercial (recommended)

### Layout

- **Left pane**: Claude Code chat. Prompt, skill load indicator, summary.
- **Right pane**: real artifact view. Editor for the `counter.compact` write
  step, then terminal for `mn` output.
- **Bottom**: minimal video player chrome that auto fades after 1 second.

### Storyboard (18 seconds)

```
0:00 to 0:02   COLD OPEN
               left: empty Claude Code chat, cursor blinking
               right: empty src/ folder in editor
               fade in title: "mn  one CLI for Midnight"

0:02 to 0:04   PROMPT
               left: prompt types in (sped up)
               "> Build a Compact counter contract and deploy it on
                  localnet, then call increment and confirm state."
               right: still empty editor

0:04 to 0:05   SKILL LOAD
               left: green dot
               "Skill (wallet-cli)  Loaded"
               right: still empty

0:05 to 0:08   SCAFFOLD
               left: small bullet "Writing counter.compact"
               right: editor animates the contract file appearing line
                      by line (sped up)
               tiny label bottom right: "6 lines of Compact"

0:08 to 0:11   COMPILE + DEPLOY
               left: bullets stack up fast:
                 "npm run compact"
                 "mn contract deploy"
               right: pane swaps to terminal
                      spinner animates briefly
                      address line appears, briefly highlighted:
                      Address: 64da9d71cb9dedf186d4f92c45a5a8ab...
               tiny label: "deploying to undeployed"

0:11 to 0:14   CALL + STATE DIFF
               left: bullets stack up:
                 "mn contract call increment"
                 "mn contract state"
               right: terminal shows two state reads.
                      visual diff highlight:
                      before: round: 0
                      after:  round: 1
               tiny label: "0 to 1"

0:14 to 0:17   PAYOFF
               left: final message bubble:
               "Deployed counter at 64da9d71... Round went from 0 to 1."
               right: holds on the round: 1 output, slightly zoomed
               tiny label: "one prompt. zero glue code."

0:17 to 0:18   END CARD
               both panes fade. centered:
               "mn"
               "npm install -g midnight-wallet-cli"
```

Description text appears at four moments only:

1. Title
2. "6 lines of Compact"
3. "0 to 1"
4. Closing tagline

### Recording prompt (paste into Claude Code at recording time)

> Build a Compact counter contract and deploy it on localnet, then call
> the increment circuit and confirm state changed.

### Pre-recording checklist

1. `mn localnet up` once before recording so the localnet is warm.
2. `mn dev` once and quit so `dev-alice`, `dev-bob`, `dev-carol` exist
   and are pre funded.
3. Close all other windows. Hide dock and menu bar. Full screen Claude Code.
4. Disable color in JSON output if needed: `NO_COLOR=1` for the demo session.
5. Capture at 1440p minimum.

### Production estimate

Roughly 90 minutes total once recordings are in hand. Speed up tool calls
in editing with frame skips, hold on result moments (address, round 0,
round 1).

### Tooling

- Capture: ScreenStudio (auto cursor zoom), Cleanshot, or Kap.
- Edit: ScreenStudio, Final Cut, DaVinci Resolve, or CapCut Desktop.
- Music: ambient minimal, YouTube Audio Library or Pixabay.
- Fonts: JetBrains Mono for terminal, Inter for overlays.

---

## Format B, voiced walkthrough (alternative)

Use when you need a longer pitch with narration, e.g. for a livestream
or conference recording.

### Cold open (15s)

> If you are building dApps on Midnight, or you are an AI agent helping a
> developer build one, this is the wallet and development CLI you should
> be using. Wallet management, contract deployment, and a development
> loop in one binary that speaks JSON natively.

### For developers (60s)

> Three jobs, one CLI.
>
> First, wallets. `mn wallet generate`, `list`, `use`, `info`. Three
> networks, one command set. Undeployed for local development, preprod
> and preview for shared testnets. Wallets persist under
> `~/.midnight/wallets/` with a tip aware cache so reopening takes
> seconds, not minutes.
>
> Second, the development loop. `mn dev` watches your `.compact` files,
> recompiles on save, ensures localnet is up, and provisions three pre
> funded test wallets. Press `d` to deploy, `t` to run tests, `q` to quit.
>
> Third, contract operations. `mn contract inspect`, `deploy`, `call`,
> `state`. Same commands, same flags, any network. The CLI bundles its
> own SDK dependencies, so your project does not need to install eleven
> `@midnight-ntwrk` packages just to ship a deploy.

### For AI agents (75s)

> Every command takes `--json` for structured output. Exit codes are
> stable: zero success, two invalid args, five `DUST_REQUIRED`, six
> `STALE_UTXO` or `PROOF_TIMEOUT`. The full table is in
> `src/lib/exit-codes.ts`.
>
> An MCP server ships with the package, exposing 24 tools that mirror the
> CLI surface. Tool names are stable. Parameter names are stable. The
> skill resource splits into a small core and a full reference, so your
> default agent context stays under a thousand tokens.
>
> Every JSON output shape is documented in `docs/JSON_CONTRACT.md`, the
> surface we promise not to break without a major version bump. Errors
> return discriminating codes (`DUST_REQUIRED`, `STALE_UTXO`,
> `PROOF_TIMEOUT`, `INVALID_DUST_SPEND_PROOF`, `STALE_CACHE`,
> `SYNC_TIMEOUT`) that your agent can match on, not prose it has to parse.

### Demo over real Claude Code session (3 min, voiceover only)

> Empty directory. Claude Code open. Midnight wallet MCP and the
> `wallet-cli` skill loaded. One prompt:
>
>   "Build a Compact counter contract and deploy it on localnet, then
>    call increment and confirm state changed."
>
> Hit enter. Claude goes straight to work.
>
> Notice what is not happening. Claude is not asking which package
> manager, which language version, which wallet has funds. It reads the
> wallet CLI skill, sees `dev-alice` is the convention on localnet, just
> picks it. It runs `npm run compact`, watches the exit code, moves on.
> It runs `mn contract deploy --json`, parses the address from the
> documented shape, never regexes a log line.
>
> Around forty seconds on a warm localnet. Compile, deploy, state read,
> circuit call, state read again. Counter goes from zero to one. Claude
> wraps up with a one paragraph summary: address, round before, round
> after.
>
> Want preprod. Same prompt, append "use my alice wallet on preprod."
> Claude swaps two flags. Same artifacts, real testnet.
>
> Parameterised constructor:
> `mn contract deploy --args '{"deadlineSecs": 300}'`. Missing
> witnesses module: the CLI tells Claude exactly which paths it searched
> and which TypeScript source to build.

### Closing (15s)

> One CLI for wallets, the dev loop, and contracts. Stable JSON. Stable
> MCP. Stable exit codes. Install with `npm install -g midnight-wallet-cli`.
> Source, full feature list, and the JSON contract are in the repo.

---

## Both formats, what to install before recording

```bash
npm install -g midnight-wallet-cli@latest
mn localnet up
mn dev   # press q after dev wallets are provisioned
```

## Reference assets

- `CHANGELOG.md` for the canonical feature list.
- `docs/JSON_CONTRACT.md` for the stable surface.
- `docs/AGENT-PROTOCOL.md` for the MCP contract.
- `docs/BEGINNER_JOURNEY.md` for the narrated walkthrough used as basis
  for the demo flow.
