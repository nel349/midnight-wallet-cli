# Plan: midnight-starship as flagship dApp + CLI testing gate (on the current matrix)

## Why

Exploratory testing this session proved the CLI's contract path is effectively untested
against real contracts, because of a **version skew**: the CLI runs compact-runtime
**0.16.0**, but every compiled contract on the machine (official `example-counter`,
`example-bboard`, and `midnight-starship`) is **0.15.0**, so the runtime version check
rejects them all. Recompiling `counter.compact` with **compactc 0.31.1** produces
runtime-0.16.0 artifacts (verified) — so the fix is to bring a real dApp onto the matrix
and use it as a standing integration gate.

## Current support matrix (docs.midnight.network/relnotes/support-matrix)

- Node **1.0.1**, Indexer **4.3.3-hotfix**, Proof server **8.1.0**
- Compact toolchain (compactc) **0.31.1**, Compact runtime **0.16.0**
- Midnight.js **4.1.1**, Wallet SDK **1.2.0**, DApp Connector API **4.0.1**

## midnight-starship gap (measured)

`~/Development/tech-moderator/midnight-starship` currently pins:
- compact-runtime **0.15.0** → **0.16.0**
- ledger-v8 **^8.0.3** → **^8.1.0**
- midnight-js-* **^4.0.2** → **^4.1.1**
- dapp-connector-api **^4.0.1** (already matches)
- contract `pragma language_version >= 0.20` (compactc 0.31.1 satisfies it)
- Compiled `contract/(src|dist)/managed/starship` is 0.15.0 → recompile with compactc 0.31.1

## Migration steps (starship repo)

1. Bump the dep versions above in every `package.json` that pins them (root + any of
   `contract/`, `api/`, `game-ui/` that do). Consider adopting the Wallet SDK **1.2.0**
   barrel where the app imports wallet-sdk sub-packages.
2. Recompile the contract with **compactc 0.31.1** (`~/.compact/versions/0.31.1/…/compactc
   starship.compact <out>`), replacing `contract/src/managed/starship` — verify the emitted
   code reports runtime 0.16.0.
3. `npm install` (or the repo's package manager) and rebuild `contract` → `api` → `game-ui`.
4. Regenerate/verify the witnesses module (`contract/dist/witnesses.js`) still builds.
5. Smoke-deploy against localnet with the CLI (`mn contract deploy --path contract …`) and
   run a circuit + read state.

## Testing-gate role

Starship becomes the CLI's real-contract integration gate on **undeployed (localnet)**,
exercising in one flow: `contract inspect/deploy/call/state`, plus `wallet balance` (with
the new shielded-skip), `transfer`, `dust register/status`. A green run = the CLI is
matrix-compatible end to end. Wire it as a scripted gate (compile → localnet up → deploy →
call → assert state) that runs before a CLI release.

## Blockers this gate must not paper over (found this session)

- **Contract-deploy error handling is poor:** version mismatch and missing `compact-runtime`
  surface as raw stack traces classified `UNKNOWN`. Fix the CLI to detect both and emit
  clear, actionable messages (the voting witness-missing error is the good model).
- **`contract deploy` → "Wallet not synced yet" / mn-serve connection** on undeployed even
  after the version fix — the deploy connects to an `mn serve` and the wallet sync races.
  Needs a proper "wait for synced" or a clear error. (Cold dust was one cause; warming
  kuiraval's dust to 1.25B cleared one instance.)
- **Hosted-network writes (preprod/preview) are wall-blocked by the ~1.3M-event dust
  first-sync** — the gate runs on undeployed for now; hosted writes need the dust-sync
  optimization (separate track) before they're practical.

## Execution note

This is a cross-repo migration that needs a stable Docker/localnet and a clean
compile→install→build→deploy loop — best run as a focused session, not tail-ended onto a
long one. Environment was unstable this session (Docker crashed repeatedly).
