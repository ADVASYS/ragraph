# Packaging

RAGraph is packaged with **electron-builder** from `electron-builder.yml`. This document describes the targets, the native-module handling, signing and auto-update.

## Targets

The default configuration produces one installer per platform:

| Platform | Target | Architectures |
| --- | --- | --- |
| Windows | `nsis` | x64 |
| macOS | `dmg` | x64, arm64 |
| Linux | `AppImage`, `deb` | x64, arm64 |

The macOS config declares the productivity category; the Linux config declares Office; the Windows installer allows the user to change the installation directory and is per-user by default.

## Native modules

Some native modules must stay **outside** the ASAR archive, otherwise their runtime loader cannot find the `.node` / `.so` binaries. They are listed under `asarUnpack` in `electron-builder.yml`:

- `better-sqlite3` — SQLite binding for the meta and graph databases.
- `@lancedb/lancedb` — native LanceDB client and its Arrow dependency.
- `sharp` — image processing for chat attachments.
- `@huggingface/transformers` — ONNX runtime + tokenizer assets for the local embedder.

A `postinstall` hook (`electron-builder install-app-deps`) rebuilds native modules against the Electron ABI after `npm install`.

## Build scripts

```bash
npm run build         # Compiles main, preload and renderer to out/
npm run package       # Produces installers for the current OS into release/<version>/
npm run package:dir   # Unpacked app (useful for debugging native modules)
```

Cross-platform builds work where the underlying toolchain is available (macOS builds a universal `.dmg`; Linux can cross-compile to `AppImage` + `.deb`; Windows needs a Windows host or wine with NSIS for signed installers).

Artifacts land in `release/<version>/`. Configure `electron-builder.yml` → `directories.output` to change that.

## Code signing

### Windows

Set one of:

- `CSC_LINK` + `CSC_KEY_PASSWORD` pointing to a `.pfx` certificate, **or**
- `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` for a Windows-specific certificate.

EV certificates, if supplied, are detected automatically by electron-builder.

### macOS

Notarization requires:

- `APPLE_ID` — your Apple developer account email.
- `APPLE_APP_SPECIFIC_PASSWORD` — an app-specific password issued from appleid.apple.com.
- `APPLE_TEAM_ID` — the Team ID from your Apple developer account.
- `CSC_LINK` + `CSC_KEY_PASSWORD` — the Developer ID Application certificate as a `.p12`.

Hardened runtime is enabled by default; ensure the entitlements file lives at `build/entitlements.mac.plist` if you need to declare additional capabilities.

### Linux

No signing is mandatory. If `GPG_KEY_ID` is set, `.deb` artifacts are signed with the matching GPG key.

## Auto-update

The configuration is auto-update ready. `electron-builder.yml` declares a generic update feed (`provider: generic`, `url`) that can be replaced with:

```yaml
publish:
  provider: github
  owner: <you>
  repo: ragraph
```

or any other provider supported by electron-updater (s3, spaces, keygen, …). The updater client itself (`electron-updater`) is already a dependency; enable it in `electron/main/index.ts` by calling `autoUpdater.checkForUpdatesAndNotify()` on ready (currently wired but disabled by default so self-builds do not ping a public feed).

## Reproducibility

- Pin Node to **20 LTS** in your CI runner (matches development).
- Run `npm ci` (not `npm install`) so `package-lock.json` is honored.
- Commit the lockfile. `electron-builder` hashes dependencies into the installer name via `artifactName` — consistent lockfiles produce consistent artifacts.

## Troubleshooting

- **Native module mismatch** (`Module did not self-register` / `invalid ELF header`): run `npm run postinstall` (or `npx electron-builder install-app-deps`) to rebuild against the Electron ABI.
- **`better-sqlite3` fails to load in production**: make sure it is inside `asarUnpack`. The default config already includes it; a custom `files` list may have removed it.
- **Blank window on first launch of a packaged build**: check the CSP in `src/index.html`. A stricter CSP than the dev-mode config will block `unsafe-eval` needed by React DevTools in production — keep production CSP as shipped.
- **DMG fails notarization**: verify the `APPLE_*` env vars and that the certificate matches `APPLE_TEAM_ID`. `electron-builder` logs the exact Apple response on failure.

## Release checklist

1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md` (create one at the first release).
3. `npm run typecheck && npm run lint && npm run test && npm run test:e2e`.
4. `npm run package` on every target platform.
5. Attach artifacts to the GitHub release (or your publish provider).
6. Tag: `git tag v<version> && git push --tags`.
