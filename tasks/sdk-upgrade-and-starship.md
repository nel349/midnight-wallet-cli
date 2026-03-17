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
- [ ] Create `midnight-starship/` repo with npm workspaces (contract, api, game-ui)
- [ ] Add `.mcp.json` with midnight-mcp + midnight-wallet MCP servers
- [ ] Add CLAUDE.md

### Phase 2: Contract
- [ ] Write `starship.compact` — leaderboard with Maps, selective disclosure
- [ ] Write `witnesses.ts`
- [ ] Compile with `compactc`, verify circuit keys generated

### Phase 3: API Layer
- [ ] `common-types.ts` — StarshipProviders, StarshipContract types
- [ ] `StarshipAPI` — deploy, join, submitScore, getLeaderboard, proveElite
- [ ] Observable derived state from public ledger

### Phase 4: Provider Wiring
- [ ] `wallet-connector.ts` — createWalletClient wrapper
- [ ] `midnight-providers.ts` — 6 MidnightProviders from ConnectedAPI
- [ ] Verify full flow: connect → deploy → call circuit → read state

### Phase 5: Game Engine
- [ ] Adapt Galaga reference (https://github.com/jwilliams219/galaga) to TypeScript + Canvas
- [ ] Player ship, projectiles, enemies, scoring, health
- [ ] Game state machine (menu, playing, game over)

### Phase 6: UI Integration
- [ ] Connect screen (wallet URL input, connect button)
- [ ] HUD (score, health, wallet connection status)
- [ ] Game over → "Submit Score?" → contract call
- [ ] Leaderboard overlay (reads on-chain state)
- [ ] "Prove Elite" button (selective disclosure demo)

### Phase 7: Polish
- [ ] Error handling for wallet/contract interactions
- [ ] Loading states during deployment, balancing, proving
- [ ] README with setup instructions
- [ ] Educational disclaimer

---

## Notes

- wallet-sdk 2.0.0 stable still depends on ledger-v7 — cannot target preview until v8 wallet-sdk is published
- Dust-revert bug NOT fixed in v2.0.0 stable — patch stays
- Preview network endpoints already configured in CLI (`src/lib/network.ts`)
- Reference game: vanilla JS + Canvas, no framework
- Contract + connector integration are the priority, game is the vehicle
