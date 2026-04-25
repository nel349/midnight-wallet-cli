# midnight-wallet-cli — Agent Skill (Core)

You have access to the `midnight-wallet-cli` MCP server. This is the **core** skill — intent routing and non-negotiable safety rules. Fetch `midnight-wallet://skill/full` on demand for canonical multi-step flows, error-recovery recipes, concept primers (NIGHT, DUST, shielded vs unshielded), network selection, and deeper context.

## Intent routing (natural language → tool)

| User says | Call this tool |
|---|---|
| "Create a new wallet called alice" | `midnight_wallet_generate({ name: "alice" })` |
| "Show my wallets" / "list wallets" | `midnight_wallet_list()` |
| "Switch to bob" / "use wallet bob" | `midnight_wallet_use({ name: "bob" })` |
| "What's my balance?" | `midnight_balance()` |
| "Balance for this address 0x…" | `midnight_balance({ address: "mn_addr_..." })` |
| "Send 100 NIGHT to alice" | `midnight_transfer({ to: "alice", amount: "100" })` — ask consent first |
| "Send shielded" | use the shielded address directly, or pass `--shielded` via the CLI |
| "Fund my wallet" (localnet only) | `midnight_airdrop({ amount: "1000" })` |
| "Register dust" / "I need fees" | `midnight_dust_register()` |
| "Am I registered for dust?" | `midnight_dust_status()` |
| "Start localnet" / "start a local network" | `midnight_localnet_up()` |
| "Stop localnet" | `midnight_localnet_stop()` |

## Safety rules (non-negotiable)

- **Read tools** (`readOnlyHint: true`) — safe to call without user consent. Examples: balance, info, list, status, address derivation.
- **Destructive tools** (`destructiveHint: true`) — require explicit user consent before calling. Examples: transfer, airdrop, dust register, wallet generate, wallet remove, cache clear, localnet down.
- **Open-world tools** (`openWorldHint: true`) — touch the network/chain/Docker. Can fail non-deterministically; retry is usually safe for reads, risky for writes.
- **Never** auto-execute a fund-moving operation. Always describe amount + recipient + network first.
- **Never** invent a mnemonic, seed, or private key. If the user needs one, call `midnight_wallet_generate`.
- **Transfers use a two-step confirmation token.** `midnight_transfer` returns a pending token + description; you must show the description verbatim and then call `midnight_confirm_operation({ token })` only after the user explicitly says yes. Full flow in `midnight-wallet://skill/full`.

## When to fetch the full skill

- On any error from a tool call → fetch `midnight-wallet://skill/full`, find the recipe in "Error recovery recipes".
- Before a multi-step flow (first session, deploying a contract, transfer with confirmation) → fetch `/full` for the canonical sequence.
- When the user asks conceptual questions (what is dust, shielded vs unshielded, which network) → fetch `/full`.
- For per-tool details: read the tool description in `tools/list`.
- For CLI reference: `mn help <command>`.
