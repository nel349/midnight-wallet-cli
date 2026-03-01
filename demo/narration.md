# midnight-wallet-cli — Demo Narration Script

Feed each scene's narration text to ElevenLabs separately, then sync with the screen recording in your video editor.

---

## Scene 1: Intro (show title card or README)

> Hey everyone, I'm Norman — or as some of you know me, Norm. I'm a software developer, Midnight Aliit, and tech moderator for Midnight. I've been working on wallet alternatives to give developers the best possible dev experience. Today I want to show you midnight wallet CLI — a standalone command-line wallet for the Midnight blockchain. It lets you manage wallets, check balances, transfer NIGHT tokens, and run a local network, all from the terminal. It also includes a built-in MCP server, so AI agents in Claude Code, Cursor, or VS Code can call wallet operations directly. Let me show you how it works.

---

## Scene 2: Install (show npm install command)

> First, install the package globally with npm. This gives you two commands: midnight, or mn for short, and midnight wallet MCP for AI agent integration.

---

## Scene 3: Start local network (show localnet up + status)

> Let's start by spinning up a local Midnight network using Docker. We run midnight localnet up, which launches a node, an indexer, and a proof server. Once the services are running, we can check their status with midnight localnet status.

---

## Scene 4: Generate wallet (show generate + info)

> Now we generate a new wallet on the undeployed network. The CLI creates a BIP-39 mnemonic, derives a seed, and saves everything to a wallet file. We can view the wallet details with midnight info — this shows the address and network without exposing any secrets.

---

## Scene 5: Airdrop (show airdrop + balance)

> On the local network, we can fund our wallet using the airdrop command. Let's airdrop 1000 NIGHT tokens. The transaction is submitted to the local node and confirmed within seconds. Checking the balance confirms the tokens arrived.

---

## Scene 6: Transfer (show transfer + balance)

> Let's transfer 100 NIGHT to another wallet. We generate a second wallet, then run midnight transfer with the recipient address and amount. After the transaction confirms, our balance reflects the transfer.

---

## Scene 7: Dust (show dust register + status)

> Midnight uses dust tokens for transaction fees. We register our NIGHT tokens for dust generation with midnight dust register, then check the status. This is required before deploying or interacting with smart contracts.

---

## Scene 8: JSON output (show --json flag)

> Every command supports a json flag for structured output. This makes it easy to integrate with scripts and automation. Agents can also use midnight help json to discover all available commands and their output schemas programmatically.

---

## Scene 9: MCP Server intro (show .mcp.json config)

> The CLI includes a built-in MCP server for AI agent integration. To set it up, just add a simple config file to your project. For Claude Code, create a dot MCP dot json file with the npx command pointing to midnight wallet CLI with the MCP flag. The same pattern works in Cursor, VS Code, and other editors.

---

## Scene 10: MCP in Claude Code (show Claude Code using MCP tools)

> Once connected, the AI agent gets access to 17 typed tools covering all wallet operations. Let me show this in Claude Code. I can ask it to check my balance, and it calls the midnight balance tool directly — no shell commands, no output parsing. I can also ask it to airdrop tokens or make a transfer, and it handles everything through the MCP protocol.

---

## Scene 11: Outro

> That's midnight wallet CLI — a complete wallet toolkit for the Midnight blockchain, with first-class support for AI agents. Install it with npm install minus g midnight wallet CLI, and check out the README for full documentation. Happy building.
