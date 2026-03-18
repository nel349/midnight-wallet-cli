# SDK Upgrade + Starship DApp

## Part 1: CLI SDK Upgrade (wallet-sdk RC → stable)

- [x] Update wallet-sdk packages from RC to stable 2.0.0
- [x] Update wallet-sdk-hd 3.0.0 → 3.0.1
- [x] Update wallet-sdk-address-format 3.0.0 → 3.0.1
- [x] npm install + verify no errors
- [x] npm run typecheck (fixed: `CoreWallet` → `/v1` import, `pendingDustTokens` → `pendingDust`, `UtxoWithMeta` → `/v1`)
- [x] npm test — all pass
- [x] npm run build — success
- [x] Add midnight-mcp server (`.mcp.json`)
- [x] Smoke test on preview network — wallet generated, balance works, transfer works! Dust sync needed 120s (11,878 events). Fixed: bumped remote timeout to 120s, added cache-on-timeout for retry resume, added --verbose flag for diagnostics.

### Ledger-v8 Swap (optional — preview works with ledger-v7)

Preview network works fine with wallet-sdk 2.0.0 + ledger-v7. Upgrade to ledger-v8 when wallet-sdk publishes a compatible version.

- [ ] Wait for wallet-sdk to publish version targeting ledger-v8
- [ ] Update 7 files: `ledger-v7` → `ledger-v8` imports
- [ ] Re-test dust-revert patch (may be fixed upstream — remove if so)
- [ ] Full test suite pass on ledger-v8

---

## Part 2: Starship DApp (separate repo)

### Phase 1: Scaffold
- [x] Create `midnight-starship/` repo with npm workspaces (contract, api, game-ui)
- [x] Add `.mcp.json` with midnight-mcp + midnight-wallet MCP servers
- [x] Add CLAUDE.md
- [x] Add `.gitignore` (mirrors bboard — ignores `managed/`, `dist/`, `node_modules/`)

### Phase 2: Contract
- [x] Write `starship.compact` — leaderboard with Maps, playerHash, selective disclosure
- [x] Write `witnesses.ts` with educational comments
- [x] Compile with `compact compile`, verify circuit keys + zkir generated
- [x] Contract `index.ts` — exports + `compiledStarshipContract` via `CompiledContract.make().pipe()`

### Phase 3: API Layer
- [x] `common-types.ts` — StarshipProviders, StarshipContract, LeaderboardEntry/State types, full JSDoc
- [x] `StarshipAPI` — deploy, join, submitScore, proveElite, state$ observable
- [x] Private constructor + static factory pattern (matches bboard)
- [x] Extracted `deriveLeaderboardState` and `generatePrivateState` as named internal functions
- [x] No `as any` casts — clean type flow from `compiledStarshipContract`
- [x] Code review pass — demo-quality JSDoc, educational comments

### Phase 4: Provider Wiring
- [x] `wallet-connector.ts` — createWalletClient wrapper with toast notifications
- [x] `midnight-providers.ts` — 6 MidnightProviders from ConnectedAPI (updated for midnight-js 3.2.0 API)
- [x] Network mode support — `.env.undeployed`, `.env.preprod`, `.env.preview` + `setNetworkId()`
- [x] Vite config — WASM, top-level-await, node polyfills, `crypto.timingSafeEqual` shim
- [x] Contract deploy verified on preview network

### Phase 5: Game Engine
- [x] Adapted Galaga reference to TypeScript + Canvas (320×240 virtual, 3x scale)
- [x] Player ship, torpedos, 3 enemy types (bee/butterfly/boss), particles, collisions
- [x] Game state machine (connect → deploying → menu → playing → gameover → submitting → proving → leaderboard)
- [x] Wave spawning with stage progression
- [x] Procedural sound effects — shoot, enemy hit, boss hurt/death, player death, diving, level start
- [x] Theme music — looping 8-bit melody with bass, hi-hat, kick
- [x] Deploying screen — blocks menu until contract is ready, shows status + loading bar

### Phase 6: UI Integration
- [x] Connect screen (wallet connect via `mn serve`, ESC to skip)
- [x] Deploying screen (status messages during contract deploy/join)
- [x] HUD (score, lives, stage, wallet connection indicator)
- [x] Game over → alias input → "Submit Score?" → contract call → submitting screen
- [x] Alias input — player types callsign on game over (max 12 chars, blinking cursor)
- [x] Leaderboard overlay (reads on-chain state via `state$`)
- [x] "Prove Elite" — P key on leaderboard → threshold input prompt → proving screen → ZK proof → toast
- [x] Proving screen — "Generating zero-knowledge proof..." with educational text about selective disclosure

### Phase 7: Polish
- [x] Error handling for wallet disconnection, contract failures
- [x] Loading states during deployment (deploying screen)
- [x] Loading states during score submission (submitting screen)
- [x] Loading states during ZK proof (proving screen)
- [x] Removed dead code (`resetScore`)
- [x] Moved hardcoded provider values to `config.ts` constants
- [ ] README with setup instructions
- [ ] Educational disclaimer
- [ ] Credit jwilliams219/galaga

---

## Remaining Work

### Documentation
- [ ] README with setup instructions (prerequisites, install, compile contract, run dev server, connect wallet)
- [ ] Educational disclaimer (demo project, not production)
- [ ] Credit jwilliams219/galaga for game reference

### Nice-to-have
- [ ] Visual indicator on leaderboard for players who proved elite status
- [ ] Favicon for the game

---

## Notes

- wallet-sdk 2.0.0 stable still depends on ledger-v7 — cannot target preview until v8 wallet-sdk is published
- Dust-revert bug NOT fixed in v2.0.0 stable — patch stays
- Preview network endpoints already configured in CLI (`src/lib/network.ts`)
- Reference game: vanilla JS + Canvas, no framework
- Contract + connector integration are the priority, game is the vehicle
- Dependencies aligned to Preview versions: compact-runtime 0.14.0, midnight-js 3.2.0, ledger-v8 8.0.2, dapp-connector-api 4.0.1
