# Releasing

Two things are released separately: the **runtime** (Hermes and its tools, as packs on a GitHub Release) and the **extension** (the VSIX). The extension embeds a manifest that pins one runtime by URL, size and SHA-256.

## 1. Build a runtime

Workflow: `.github/workflows/runtime-release.yml` (manual dispatch).

| Input | Meaning |
|---|---|
| `hermes_ref` | Hermes tag or full commit SHA. Use a canary tag such as `v0.21.4+canary.20260928T071354Z`. The old calver releases (`v2026.9.x`) have no sealed-payload build lane. |
| `runtime_id` | Short id for the release and file names, for example `hrt-20260928`. Never reuse an id for different bytes. |

For each platform (`win32-x64` on `windows-latest`, `linux-x64` on `ubuntu-latest`) the workflow:

1. Checks out Hermes at `hermes_ref` and builds the sealed core payload with `scripts/bundles/native_build.py`.
2. Writes `runtime.json` (the launch contract the extension reads).
3. Splits the payload into packs: `core`, `browser`, `media`, `computer-use`, `llm-cpu`, `llm-cuda`, `llm-hip`, `llm-vulkan`, `cli-tools`, `offline-cache`. Every pack must stay under 1.9 GiB.
4. Writes `manifest-<platform>.json` with the URL, size and SHA-256 of each pack.
5. **Verifies the packs end to end**: extracts them into a folder with spaces and non-ASCII characters, cuts the network with a dead proxy, then runs `--version`, `--check`, a full ACP round trip and a terminal tool call.
6. Uploads the packs and the manifest to the release `runtime-<runtime_id>`.

The Windows build takes about 25 to 35 minutes (it compiles native extras with MSVC).

## 2. Embed the runtime in the extension

```bash
node scripts/sync-runtime-manifest.mjs hrt-20260928
git add runtime-manifest/manifest.json
```

The script downloads both manifests from the release, checks every URL is under that release and every hash is well formed, and merges them into `runtime-manifest/manifest.json`. A test (`embeddedManifest.test.ts`) fails if the file is missing a platform or is malformed.

## 3. Release the extension

1. Set `version` in `package.json` and add the entry to `CHANGELOG.md`.
2. `npm ci && npm run verify` (type check, secret scan, tests, build, audit, VSIX).
3. Tag and push:

```bash
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

`.github/workflows/release.yml` re-runs the gate, names the VSIX `hermes-by-rangel-tech-<version>.vsix`, writes its SHA-256 and creates the GitHub Release. Tags with a `-suffix` are marked as prereleases. The tag must match `package.json` (`v0.1.0-beta.1` requires version `0.1.0`).

## Bumping the Hermes version

Run the runtime workflow with the new ref and a new id, sync the manifest, and cut a new extension version. Users on the old runtime get a notice and update when they choose; a running session is never switched.

## Marketplace

Not automated yet. Publishing needs a Marketplace publisher and an Open VSX namespace (see the decisions in the development spec). Until then, the VSIX on the GitHub Release is the distribution channel.
