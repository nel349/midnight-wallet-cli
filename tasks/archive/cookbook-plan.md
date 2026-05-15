# Midnight Cookbook & Recipe Plan

## Why

Setting up a Midnight dApp on Android (or any target) today means stitching together environment setup, network choice, wallet provisioning, contract deploy, and app build. Each piece lives in a different doc, the steps depend on the host OS, and most failures happen at the seams. New developers ask the same questions in dev-chat repeatedly, and even experienced developers lose hours when their environment drifts.

Modern AI agents can perform almost all of these steps, but only if given a structured procedure with verification at every checkpoint. Free-form prose docs do not give them that.

## What we are building

A small ecosystem of three pieces that work together:

- **Cookbook**: a website where the developer clicks options (platform, target, example, network, wallet choice, IDE) and gets back a generated recipe.
- **Recipe**: a plain-markdown runbook the developer pastes into their agent. The recipe leans on the CLI as its diagnostic and executor at every step.
- **Session**: a JSON file the agent maintains as it works through a recipe. Captures step status, produced artifacts (wallet addresses, contract addresses), and environment snapshots. Survives interruptions; enables resume; doubles as a complete bug report on failure.

The CLI gains the commands needed to make this loop work: a structured `mn doctor`, session management primitives, and the recipe templates themselves.

## Vocabulary

- **Cookbook**: the website with the option form.
- **Recipe**: the generated runbook the agent follows.
- **Session**: per-run progress and state file.
- **Live step**: a step that changes real state (deploy, install, spend). Always pauses for explicit confirmation.

## Goals

- A new developer with no prior Midnight context reaches a working dApp on device using one pasted recipe, without asking for help.
- Agents follow recipes correctly without inference or hallucination, because every step has a structured verification gate.
- Sessions survive interruptions. Closing a laptop never loses progress.
- Live steps gate any action that costs money, time, or commits to an irreversible change.
- Failures produce a self-contained, shareable bug report.

## Explicit non-goals

These are deliberately out of scope to avoid drift and overengineering:

- A traditional documentation site. The recipe surface replaces that for the agent-driven path.
- An SDK manifest. The cookbook delivers value without one.
- A community recipe catalog. Personal and project-level recipes only, until usage justifies more.
- Multi-machine session sync, replay/time-travel, telemetry pipelines, web UI for sessions.
- AI-generated or AI-cleaned recipes. Hand-authored only.
- Cross-target reach beyond what the first phase validates.

## Success criteria

The plan succeeds if all of the following are true after Phase 1:

- A volunteer with no Midnight background gets from `git clone` to a working bboard demo on an Android emulator in under 30 minutes, using one pasted recipe and no human help.
- An interrupted session resumes correctly on the next agent invocation.
- Live steps prompt before deploy and install actions; nothing destructive happens silently.
- A failure at any step produces a session file plus logs that are sufficient to file a reproducible issue.
- At least one agent (Claude Code, Cursor, or Codex) completes the recipe end-to-end without manual intervention.

## Phasing

The work is broken into three phases. Each phase has a validation gate before the next phase begins.

### Phase 1: validate the loop on one path

Ship the smallest end-to-end slice that proves the concept works:

- One recipe targeting Mac, Android, the bboard example, on preprod.
- A new `doctor` command in the CLI that diagnoses the environment and returns structured output the agent can act on.
- Session schema with checkpointing after every completed step.
- Resume detection when an agent encounters an existing session for the same recipe.
- Live-step confirmation prompts.
- End-to-end test on a real machine with at least one agent following the recipe.

No website yet. The recipe is hand-authored markdown for this phase.

### Phase 2: generalize and polish

Conditional on Phase 1 succeeding:

- Cookbook website. Static, client-rendered, no backend.
- Linux and Windows variants of the bboard recipe.
- A second recipe (midnight-kicks).
- Localnet vs preprod selectors.
- Long-step progress reporting and notifications.
- Session-as-bug-report flow that produces a shareable artifact on failure.

### Phase 3: earn-it features

Only if Phase 2 sees real usage:

- Additional recipes (custom contract from scratch, wallet-only flows, dust-testing flows).
- Cross-platform doctor coverage (web target, server target).
- Optional cloud session sync if multi-machine resume becomes a real ask.
- Project-level recipe sharing patterns inside teams.

## Decisions made

- Recipe templates and doctor checks ship in the CLI repo, version with the CLI release.
- Sessions default to `~/.midnight/sessions/<recipe-id>-<timestamp>/`. The agent asks for confirmation on first use and remembers the choice.
- Recipes are plain markdown with no special directives beyond a small front-matter block.
- Session files are JSON, human-readable, intentionally easy to inspect with a text editor.
- The cookbook website is a static site with client-side rendering. No backend in v1.
- Recipes are hand-authored. We do not attempt to generate them from the SDK source until the recipe surface is mature enough to know what good looks like.
- Live-step gating is a flag on the step in the template. User-facing prompts describe what is about to happen in plain language; the word "destructive" never appears in the user interface.

## Open questions

These need answers before or during Phase 1:

- Where does the cookbook website live: the CLI repo with GitHub Pages, the Midnight Foundation site, or a standalone domain?
- Who owns long-term recipe maintenance? The CLI maintainers? A rotating duty? Documented in CONTRIBUTING?
- Does `mn doctor` use one command with target flags, or a subcommand per target? The former is simpler; the latter scales better.
- Should the CLI ship recipes embedded in the npm package, or fetch them from a versioned remote? Embedded is simpler and safer to start.

## Risks and mitigations

- **Adoption risk.** If the population of Midnight Android developers is too small, the work does not pay off. Mitigation: keep Phase 1 scope tight so the bet is small and the validation gate is explicit.
- **Recipe drift.** SDK changes silently break recipes. Mitigation: CI runs each recipe end-to-end against the current SDK version on a schedule. A red CI is a release blocker.
- **Doctor accuracy.** False negatives in environment checks erode trust fast. Mitigation: the doctor's output is reviewed during Phase 1 dogfooding before shipping; every check has a human-tested fix command.
- **Agent compliance.** LLMs may skip steps or improvise. Mitigation: every step has explicit verify-before-continuing language; the recipe instructs the agent to stop and report on any verification failure.
- **Scope creep.** The temptation to add manifests, community catalogs, web inspectors, telemetry. Mitigation: the non-goals list above is treated as a hard fence until a phase gate explicitly opens it.

## Validation gate before Phase 2

Before any work begins on the cookbook website or additional recipes, the Phase 1 recipe must be run with at least three different agents on at least two machines (one fresh, one with existing Midnight setup). Each run is documented with where the agent got stuck and what was fixed. Phase 2 begins only if at least one agent reaches the working-app state without human intervention, and we have a clear list of doctor and recipe improvements based on what we learned.
