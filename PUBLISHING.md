# Publishing midnight-wallet-cli

## Build

```bash
npm run build
```

Produces `dist/wallet.js` and `dist/mcp-server.js` (bundled ESM files with shebang).

## Verify

```bash
node dist/wallet.js help
node dist/mcp-server.js &  # should start without errors, Ctrl+C to stop
npm run test
```

## Local Install Test

```bash
npm pack
npm install -g ./midnight-wallet-cli-0.1.0.tgz
midnight help
mn help
midnight-wallet-mcp &  # MCP server should start, Ctrl+C to stop
npm uninstall -g midnight-wallet-cli
```

## Publish to npm

```bash
npm publish
```

`prepublishOnly` runs `build` + `test` automatically before publishing.

## Notes

- `bun build` is the build tool — users only need Node.js
- `--packages external` keeps runtime deps as imports (resolved via `node_modules`)
- `"files": ["dist"]` ensures only the compiled output is shipped
- `midnight`, `mn`, and `midnight-wallet-mcp` are registered as CLI commands via `"bin"`
