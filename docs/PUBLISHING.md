# Publishing midnight-wallet-cli

Releases are **tag-triggered**. Pushing a `v*` tag runs `.github/workflows/release-sidecar.yml`, which builds the native dust-sync sidecar for every platform and publishes the per-platform packages **and** the main package. Do **not** run `npm publish` by hand — that would ship the main package without the platform binaries, leaving its `optionalDependencies` pointing at packages that were never published.

## Build & verify locally first

```bash
npm run build          # bun-bundles dist/wallet.js + dist/mcp-server.js (Node-only at runtime)
npx tsc --noEmit
npx vitest run
node dist/wallet.js help
```

## Local install smoke test

```bash
npm pack                                   # -> midnight-wallet-cli-<version>.tgz
npm install -g ./midnight-wallet-cli-*.tgz
midnight help && mn help
npm uninstall -g midnight-wallet-cli
```

The main tarball ships only `dist/`, `docs/SKILL.md`, and `NOTICE` (see `files` in `package.json`). The native binaries live in the separate `@nel349/dust-sync-*` packages, not this tarball.

## Cut a release

1. Bump the version in `package.json`, then sync it into the platform packages + `optionalDependencies`:
   ```bash
   node scripts/sync-sidecar-versions.mjs   # pins every @nel349/dust-sync-* to the new version (exact)
   ```
2. Update `CHANGELOG.md` (dated section), commit, and push `main`.
3. Tag and push:
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
4. The `release` workflow then, on native runners per platform:
   - builds `dust-sync` with `cargo build --release --locked` (the `--locked` keeps the `ledger-v8 =8.1.0` pins so the serialized `DustLocalState` round-trips byte-identically);
   - publishes the five `@nel349/dust-sync-<os>-<arch>` packages **before** the main package (so its optional deps resolve);
   - publishes `midnight-wallet-cli`.

Dry-run the build without publishing via the workflow's `workflow_dispatch` (`dry_run: true`) — it builds all five targets and skips the publish job.

## Auth: OIDC trusted publishing

Publishing uses **OIDC trusted publishing** (no long-lived secret) once each of the six packages has a trusted publisher configured on npmjs.com (repo `nel349/midnight-wallet-cli`, workflow `release-sidecar.yml`).

**First release bootstrap** — a trusted publisher can only be attached to a package that already exists, so the very first publish needs a one-time classic **Automation** token stored as the `NPM_TOKEN` repo secret. After that release, configure the six trusted publishers and the secret can be deleted; every later tag publishes tokenless.

## Notes

- `bun build --packages external` keeps runtime deps as imports (resolved via `node_modules`); consumers only need Node.js (>= 20).
- `midnight`, `mn`, and `midnight-wallet-mcp` are registered as CLI commands via `bin`.
- The sidecar is an `optionalDependency`: a platform we don't build for, or a skipped install, cleanly falls back to the WASM dust reader — the CLI still works, just slower on a cold dust prime.
- No install/lifecycle scripts anywhere, so npm v12's script-blocking defaults don't affect installs.
