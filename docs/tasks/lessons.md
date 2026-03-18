# Lessons Learned

## CLAUDE.md Structure
- CLAUDE.md should focus on workflow, process, and principles — not be a technical spec dump
- Technical details (SDK patterns, network configs, constants, file structure) belong in DESIGN.md
- Keep CLAUDE.md concise: workflow orchestration, task management, core principles, tech stack constraints

## SDK Bug Investigation Process
- When debugging SDK issues, don't guess — add targeted diagnostics and trace the actual runtime values
- Read the SDK source code (node_modules) systematically before proposing fixes
- WASM operations can have non-obvious side effects (e.g. DustLocalState.spend() consumes UTXOs from state)
- CoinsAndBalances computed properties (totalCoins, availableCoins) may not map directly to raw state fields
- Always verify monkey-patches work at runtime — module singletons, bundler tree-shaking, and ESM live bindings can all interfere

## SDK Upgrade Checklist
- `src/lib/dust-revert-patch.ts` patches CoreWallet.{spendCoins, revertTransaction, applyFailed, applyEvents}
- On ANY wallet-sdk-dust-wallet version change: test reject flow in `mn serve` to verify dust recovery
- If the SDK fixes the revert bug, remove the patch file and the import in dapp-connector.ts
