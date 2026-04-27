# Beginner Journey: From Zero to Deployed Contract

A real-time log of what happens when someone with zero Midnight context
sits down with `mn` and tries to ship a counter contract.

**Persona:** developer who installed `mn` via `npm i -g midnight-wallet-cli`,
has never deployed a Compact contract, knows TypeScript, knows Docker exists.

**Goal:** counter contract deployed and callable on undeployed (localnet),
then on preprod.

**Working dir:** `/tmp/mn_beginner_test/`

Each section captures:
- What I tried
- What `mn` told me
- What was missing or confusing
- The "what should `mn` have said?" capture, which becomes a ticket in
  `CLI_GUIDANCE_TICKETS.md`

---

## Step 0: Cold start

**Tried:** `mn`, `mn help`, `mn help dev`, `mn help contract`, `mn dev`, `mn contract inspect`.

**What I saw:**
- `mn` and `mn help` print the same command list. Alphabetical clusters,
  no narrative, no "first time?" pointer.
- `mn help <command>` is solid for individual commands but every example
  assumes a contract already exists.
- `mn dev` in an empty dir errors with "No .compact source files found"
  and lists the four search paths. Good error, but stops there. No
  pointer to "where do .compact files come from?" or "how do I write one?".
- `mn contract inspect` says "Run `compact compile` first". Tells me
  nothing about what `compact` is, how to install it, or where to learn.

**Beginner gaps:**
1. Zero "first run" guidance. New users land on a wall of commands.
2. No `mn init` to scaffold a starter project. The journey to a deployed
   contract starts with a search through unrelated example dApps.
3. Errors say "do X" without saying how to acquire the prerequisites for X.
4. The `--agent` reference (`mn help --agent`) is not advertised to humans.
   Only the bottom line of `mn help` mentions it, and it sounds like an
   AI thing the user can ignore.

**Tickets surfaced:** 1, 2, 3, 4 (see CLI_GUIDANCE_TICKETS.md).

---

## Step 1: Scaffold and compile

**Tried:** wrote `src/counter.compact` (six lines, copied from
midnight-libraries example), wrote `package.json` with a single
`compact` script, ran `npm run compact`.

**What worked:**
- `compact compile src/counter.compact src/managed/counter` produced
  the expected `compiler/`, `contract/`, `keys/`, `zkir/` subtree.
- `mn contract inspect` recognised the contract and showed circuits.
- The contract name was inferred from the managed dir (`counter`).

**What was painful:**

1. **`compact help` lies.** The `compile` subcommand is not listed in
   `compact help`. I had to guess `compact compile` worked. (The
   commands list shows only `check`, `update`, `list`, `clean`, `self`,
   `help`.) Compact CLI bug, not `mn`'s, but `mn` could surface it.

2. **The `~/.compact/bin/compactc` shim is broken on this system**
   (`compactc.bin: No such file or directory`). `compact compile`
   works because it locates the binary differently. A beginner who
   tries the documented path of "use compactc directly" will fail.

3. **No template / example to start from.** I had to find a known
   example in `midnight-libraries/compact/tools/compact/contract/counter.compact`
   to know the correct pragma and `import CompactStandardLibrary`.
   None of `mn`'s output mentions where to find this.

4. **No `package.json` template.** The `compact` script is
   project-specific. The dependency list for runtime deploys (eleven
   `@midnight-ntwrk/*` packages, plus `ws`) is documented nowhere a
   beginner would look. (We just bundled them via NODE_PATH in
   CLI_FEEDBACK #1, but the user still has to know that.)

**Tickets surfaced:** 5, 6, 7.

---

## Step 2: First deploy on undeployed (localnet)

**Tried:** `mn dev` once briefly to confirm setup chain (project detect,
localnet check, dev wallet provisioning, first compile). Then
`mn contract deploy --network undeployed --wallet dev-alice`.

**What blew up (in order):**

### 2a. The CLI_FEEDBACK #1 fix didn't actually work

`Cannot find package '@midnight-ntwrk/midnight-js-network-id'`. Same
error the kuira-android user filed weeks ago. The "fix" added NODE_PATH
to the spawned `node` process, but Node's docs are explicit: NODE_PATH
is honored for CommonJS only, not ESM. The generated deploy script is
ESM (`.mjs`), so the env var was completely inert.

**Replaced with:** symlink approach. Symlink our `node_modules` into
`dappDir/node_modules` (only if the user has none of their own), run,
then unlink on the way out. ESM resolution walks up from the
generated script, the user's compiled contract, and the user's
witnesses.js, all of which find our symlinked deps.

### 2b. Our package.json was missing the deps the deploy script needs

Even with the symlink fix, the deploy still failed because `mn` itself
didn't have `@midnight-ntwrk/midnight-js-contracts`,
`midnight-js-node-zk-config-provider`,
`midnight-js-http-client-proof-provider`,
`midnight-js-level-private-state-provider`, or `midnight-js-utils` in
its own `package.json`. The original "bundle SDK deps" commit message
was aspirational. Added the 5 missing packages to dependencies.

### 2c. Nested node_modules duplicated network-id, defeating setNetworkId()

After installing the 5, deploy reached `setNetworkId()` then crashed
with "Network ID has not been configured" inside `deployContract`.
The path in the stack trace told the story:
`midnight-js-contracts/node_modules/@midnight-ntwrk/midnight-js-network-id`.
A nested copy of network-id existed because contracts@4.0.4 wanted
network-id@4.0.4 but our top-level was pinned ^4.0.2 (resolved 4.0.2).
Two module instances meant `setNetworkId()` wrote to one and the
contracts code read the other. Fixed by bumping our pins to ^4.0.4 to
deduplicate.

**What worked after all three fixes:**
- `mn contract deploy` succeeded. Address printed.
- `mn contract state --address <addr>` showed `round: 0`.
- `mn contract call --circuit increment` completed.
- `mn contract state` again showed `round: 1`.
- User's dapp dir was clean afterward (no leftover symlink, no node_modules).

**Beginner gaps:**

5. The original CLI_FEEDBACK #1 fix was **never actually validated**
   end-to-end before being shipped. The commit message said "bundle SDK
   deps via NODE_PATH" but neither the bundling nor the NODE_PATH part
   worked. We need a smoke test that runs an actual deploy in CI.

6. `mn contract deploy` has too many spinner frames in non-JSON mode
   (~270 lines of `⠋ Deploying contract...` for a single deploy). Each
   frame writes a clear line so it doesn't visually accumulate, but
   when piped or captured (every CI run, every doc copy-paste, every
   AI agent log) the noise is enormous.

7. Successful deploy gives the address but no "next steps". A beginner
   doesn't know they can immediately do `mn contract state --address X`
   or `mn contract call --address X --circuit increment`. Print 1-2
   suggested next commands on success.

**Tickets surfaced:** 8, 9, 10, 11.

---

## Step 3: Same code, preprod

**Tried:** `mn contract deploy --network preprod --wallet alice` against
the same `src/managed/counter` artifact, no rebuild, no code change.

**What happened:**
- Wallet check resumed dust state from cache, scanned ~27 new dust
  events (resume from event 248785), reported "Wallet OK
  (1106000000 NIGHT, dust available)" in about 4 seconds.
- Deploy completed in roughly 30 seconds. Address printed:
  `9b3e083bf850ca17983d34110337d384d2dc626da8223c3fb2dbd3f8a2df35a3`.
- `mn contract state` returned `round: 0`.
- `mn contract call --circuit increment` completed (visible spinner
  pause for proof generation, then auto-approved
  balance/submit/sign).
- Follow-up `mn contract state` returned `round: 1`.

**Beginner gaps:**

12. Switching networks is just `--network preprod` versus
    `--network undeployed`. That's actually a quiet win — the docs
    should call this out so beginners know "the same code deploys to
    every network." Right now this is invisible. A successful
    undeployed deploy could end with a hint: "Ready for preprod? Run
    the same command with `--network preprod`."

13. The cached wallet state (the WalletDataRepository work that just
    landed) made preprod feel as fast as localnet. Without that the
    first preprod deploy would have taken minutes. This is great but
    invisible — `mn` could surface a one-liner the first time the
    cache is hit ("resumed from disk, ~4s vs ~3 min cold").

**Tickets surfaced:** 12, 13.

---

## Summary

A blank `/tmp` dir to a working counter contract, deployed and called
on both undeployed and preprod, took:

- 7 lines of `.compact` source
- 1 `package.json` script
- `npm run compact`
- `mn contract deploy`
- `mn contract call`
- (verify with `mn contract state`)

…**after** we shipped three back-to-back fixes during the journey
itself: a real CLI_FEEDBACK #1 fix (5 missing deps + a symlink, not
NODE_PATH), and the witness-discovery + --json + abort improvements
that landed on `fix/contract-deploy-feedback`.

The remaining gaps are all about teaching: a beginner can't reach this
flow today without help. Tickets 1, 2, 8, 10 (welcome, scaffolder, CI
smoke, next-steps) are the highest-leverage fixes for the *next*
beginner.

