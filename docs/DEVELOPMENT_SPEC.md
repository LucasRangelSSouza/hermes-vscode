# Hermes by Rangel Tech — Development Specification

**Status:** Draft v0.1 (research complete, no implementation started)
**Date of research:** 2026-09-28
**Companion document:** [PRODUCT_SPEC.md](PRODUCT_SPEC.md) (what to build). This document says how, in what order, and what must be proven first.

Anything marked **[verified]** was read from a primary source on the date above. Anything marked **[assumption]** has not been proven and maps to a spike in section 7. No spike may be skipped by reasoning about it.

---

## 1. Summary of the plan

1. Start from `stefanpieter/hermes-vscode` (MIT), keep its ACP client, session and webview code, and add three things around it: a **runtime manager**, a **provider manager**, and a **skills mirror**.
2. Run Hermes from a private, extension-owned `HERMES_HOME`, so the extension never touches the user's own `~/.hermes` and can generate its config safely.
3. Build the portable Hermes runtime ourselves in CI, because Hermes publishes no binary release. Pin it by version and hash, and embed that pin in the VSIX.
4. Treat ACP over stdio as the only contract with Hermes. Hermes internals change too quickly to depend on anything else.
5. Prove the ten riskiest assumptions in a short spike phase (M0) before writing production code.

The long pole is the runtime build pipeline, not the extension UI. It starts right after the spikes and runs in parallel with the extension work.

---

## 2. What the research established

### 2.1 Hermes Agent (runtime side)

| Fact | Source |
|---|---|
| ACP entry points: `hermes acp`, `hermes-acp`, `python -m acp_adapter` (entry module `acp_adapter.entry`). Logs go to stderr, stdout is JSON-RPC only. | [verified] Hermes docs, ACP page; `acp_adapter/entry.py` |
| `acp_adapter.entry` has `--version`, `--check` (verifies ACP deps and adapter imports) and `--setup` (interactive provider setup). | [verified] `entry.py` |
| ACP inherits CLI config: `HERMES_HOME/config.yaml` and `HERMES_HOME/.env`. Credentials resolve through `resolve_runtime_provider()`. | [verified] docs + `acp_adapter/auth.py` |
| `HERMES_HOME` selects the data directory. Separate homes are separate profiles (own config, `.env`, sessions, memory). | [verified] configuration docs |
| Custom OpenAI-compatible provider is a `providers.custom` block with `base_url`, `api_key: ${ENV_VAR}`, per-model `timeout_seconds` and `extra_headers`. | [verified] configuration docs |
| Secrets belong in `.env` or the process environment, referenced as `${VAR}`. | [verified] configuration docs |
| `hermes config set/get/check/migrate` exist. | [verified] configuration docs |
| Extra skill directories: `skills.external_dirs` in `config.yaml`, scanned alongside the local dir. Local skills win name conflicts. | [verified] skills docs |
| Hermes has its own GitHub "tap" mechanism (`hermes skills tap add owner/repo`) that installs skills into the local dir. | [verified] skills docs |
| `HERMES_ACP_SKIP_CONFIGURED_MCP=1` stops globally configured MCP servers from starting before the RPC loop. | [verified] ACP docs |
| Approval options offered to editors: allow once, allow for session, allow always. Timeout is `approvals.timeout` (default 300 s). | [verified] ACP docs |
| No binary release exists. GitHub releases (`v2026.9.24`, `v2026.9.21`, `v2026.9.14`) carry no assets. Distribution is an installer script that bootstraps uv, Python 3.14, Node, ripgrep, ffmpeg, Git and Chromium. | [verified] `gh api` release listing; README |
| Python requirement `>=3.11,<3.15`; console scripts `hermes`, `hermes-agent`, `hermes-acp`; extras include `acp`, `mcp`, `web`, `all`. Provider extras stay out of `[all]` and install on demand. | [verified] `pyproject.toml` |
| Hermes ships its own package manager, `pm`, with `pm/lock.json` pinning python, uv, node, ripgrep, ffmpeg, gh, git (win32 only), chromium and more. Each artifact has a URL and a SHA-256 per platform (win32-x64, linux-x64, arm64 variants, and others). | [verified] `pm/lock.json` |
| Native Windows is supported but described as early beta. The terminal tool runs commands through **Git Bash**, resolved via `pm.shell()`: PM-recorded Git package, then provisioned PATH, then conventional Git for Windows locations. There is no `HERMES_GIT_BASH_PATH` override, and MinGit is not sufficient. | [verified] Windows-native docs |
| Windows default locations: source `%LOCALAPPDATA%\hermes\hermes-agent\`, tools `%LOCALAPPDATA%\hermes\tools\`, launchers `%LOCALAPPDATA%\hermes\bin\`. Installer accepts `-HermesHome` and `-InstallDir`. | [verified] Windows-native and installation docs |
| Internal Python import paths are **not stable**. A September 2026 decomposition (PR #102117) moved most public names and shipped a temporary compat layer scheduled for removal on 2026-09-14. | [verified] `COMPAT_MANIFEST.md` |
| Windows dependencies include `pywinpty`, `pywin32`, `tzdata`, `winrt-*`. `truststore` is a core dependency, so Python-side TLS uses the OS trust store. | [verified] `pyproject.toml` |
| AV products sometimes quarantine `uv.exe` (Rust binary, unsigned); Hermes documents it as a false positive. | [verified] README |

### 2.2 The upstream extension (`stefanpieter/hermes-vscode` v3.6.0)

| Fact | Source |
|---|---|
| MIT. Copyright lines: Joao Peixoto (original) and Stefan van Biljon and contributors. Chain: `joaompfp/hermes-vscode` → `stefanpieter/hermes-vscode`. Last commit 2026-09-19. Published on the Marketplace as `stefanpieter.hermes-ai-agent-maintained`. | [verified] `LICENSE`, `gh api`, git log |
| About 10.8k lines of TypeScript, 23 test files. ACP client is 279 lines. Only two runtime dependencies (`marked`, `dompurify`). Webview has a CSP. | [verified] local inspection |
| Only four settings exist: `hermes.path`, `hermes.profile`, `hermes.editApprovalMode`, `hermes.debugLogs`. Workspace-scoped overrides are ignored for all four (good pattern, keep it). | [verified] `package.json`, `extension.ts` |
| Binary launch is one `spawn(hermesPath, ['acp'] or ['--profile', p, 'acp'])` at `src/acpClient.ts:100`, with `stdio: pipe`. A modal "allow this binary" prompt persists approved paths in `globalState`. | [verified] source |
| ACP methods used: `initialize` (protocolVersion 1), `session/new`, `session/load`, `session/prompt`, `session/cancel`, `session/set_mode`, `session/request_permission` (agent to client). | [verified] source |
| Baseline on this Windows machine: 130 of 132 tests pass. The two failures are `symlink` `EPERM` in `delegationActivityMonitor.test.ts` (needs Developer Mode or elevation), not code defects. | [verified] `npm test` run |
| CI already runs on ubuntu, macOS and windows. A hardened OIDC-based Marketplace publish workflow exists, bound to upstream's identity. | [verified] `.github/workflows` |
| The extension refuses to activate if the original `joaompfp.hermes-ai-agent` is installed (contribution ID overlap). | [verified] `successorIdentity.ts` |

### 2.3 Defects in the upstream for our use case

These are why "just rebrand it" is not enough.

**POSIX assumptions** (all must change for Windows, and for a private `HERMES_HOME`):

| Location | Problem |
|---|---|
| `extension.ts:165` | Resolves the binary with `which hermes`. No such command on Windows. |
| `extension.ts:173-175` | Fallbacks `~/.local/bin`, `/usr/local/bin`, `/usr/bin`. |
| `extension.ts:76`, `extension.ts:148` (`readAvailableHermesProfiles`) | Build `PATH` with a hard-coded `:` separator. |
| `extension.ts:58`, `extension.ts:123` | Reads `~/.hermes/config.yaml` and `default_profile_name` directly. |
| `modelCatalog.ts:74` | Reads `~/.hermes/models_dev_cache.json`. Model lists are hard-coded to Anthropic and OpenAI Codex ids. |
| `skillCatalog.ts:23` | Reads `~/.hermes/skills`. |
| `roleRunMonitor.ts:297` | Reads `~/.hermes/role-runs`. |
| `delegationActivityMonitor.ts:258` | Honors `HERMES_HOME` but falls back to `~/.hermes`. |
| `acpClient.ts:144,158` | `proc.kill()` on Windows ends only the Python process, not the shell and tool children it spawned. |

**Identity and coexistence:** command IDs, view IDs and settings all use the `hermes.` prefix. Installing our extension next to the upstream one would collide. Product spec section 27 already calls for a `hermesRangelTech.*` namespace.

---

## 3. Corrections to the product spec

The research invalidated or refined these product-spec sections. Where they conflict, this section wins.

| Product spec | Original statement | Correction |
|---|---|---|
| §7.1, §26 | "download the packaged runtime" | No packaged runtime exists upstream. We build and host it (section 6). |
| §16, §17 | Copy synced skills into a skills path that Hermes reads | Use `skills.external_dirs` to point Hermes at the mirror. No copy, and local skills keep precedence. |
| §13 | API key in SecretStorage | Still true, but the key reaches Hermes as a **process environment variable at spawn time**, referenced as `${VAR}` from a generated `providers.custom` block. No `.env` on disk. [assumption, spike S2] |
| §25 | "no system Git" | Hermes on Windows needs a Git Bash. The runtime must supply one through the PM tool store layout (section 6.2). Note the GPL implications in section 9. |
| §12 | Avoid duplicating provider logic | Keep to it, but the hard-coded model catalogs in `modelCatalog.ts` must be replaced by what Hermes reports over ACP plus the user's profile. |
| §8 | Manifest with `url` and `sha256` per build | Embed the manifest in the VSIX (section 6.4). A remote manifest is optional and only for update notices. |
| §5, §27 | Extension ID `rangeltech.hermes` | Keep, but the package `name` must be unique on the Marketplace. Confirm availability in M1. |

---

## 4. Architecture decisions

Each decision has a reason and a fallback so it can be reversed cheaply.

**D1. Base and fork mode.** Detached copy of `stefanpieter/hermes-vscode` with full history, `upstream` kept as a git remote. Not a GitHub fork, because we rename heavily and would publish under a different identity. Keep both MIT notices in `LICENSE` and `NOTICE`.
*Fallback:* `formulahendry/vscode-acp` (generic ACP client) if the fork's maintenance cost proves too high. It would lose the Hermes-specific UI.

**D2. Private `HERMES_HOME` in `runtime` mode.** The extension sets `HERMES_HOME` to `<data>/home` for the managed runtime. This isolates sessions, memory and config from any Hermes the user already has, and lets the extension own `config.yaml` generation.
*Existing Hermes mode* (product spec §7.3) keeps using the user's own home and never writes provider config.
*Every* `~/.hermes` read in section 2.3 goes through one function, `hermesHome()`.

**D3. Runtime is produced at its final path, from pinned inputs.** *Revised after spike S1 (see [spikes.md](spikes.md)).* The installed Hermes tree is **not relocatable**: shims hardcode absolute paths, state files embed the install root, and starting from a moved tree triggers a network-dependent self-update that also edits the user PATH. So the runtime is not a pre-built tree that gets moved. CI builds and verifies it, then ships the **pinned inputs** (Python archive, dependency wheels, PortableGit, ripgrep, Hermes source at a commit SHA) and the extension runs a deterministic, offline install at `<data>/runtime/<id>/`. Bundling the inputs keeps the client independent of GitHub, PyPI and npm at install time.
*Open (S11):* how to make Hermes skip its startup self-update and never touch the user PATH. Until S11 passes, D3 is not implementable.
*Rejected:* text-rewriting a moved tree (`state.db`, uv caches and PM state also embed the path), and running the official installer on the client (needs several external hosts and edits the PATH).

**D4. Launch through the interpreter, not the shim.** Spawn `<python> -m acp_adapter.entry` (documented as equivalent to `hermes acp`). Console-script shims embed absolute paths and break when a venv moves. The exact command line comes from `runtime.json` (section 6.3), so the extension does not hard-code the layout.

**D5. Provider config is generated through Hermes's own CLI.** *Confirmed by S3.* The extension calls `hermes config set model.provider custom`, `model.base_url`, `model.default` and `model.api_key '${VAR}'`. The key value is supplied only as a child-process environment variable (S2). `OPENAI_API_KEY` is not used, because the `custom` provider ignores it. The `providers.custom` block from the docs is not needed.

**D6. ACP is the only contract.** No imports of Hermes Python modules, no reading Hermes's SQLite. Reads of files under `HERMES_HOME` (skills listing, role runs, model cache) are tolerated only where the upstream extension already does them, and each is wrapped so failure degrades a feature, not the agent.

**D7. Skills are a read-only mirror.** The extension pulls the GitHub repository (tarball API, no Git) into `<data>/skills/repos/<id>/` and adds that directory to `skills.external_dirs`. Hermes's own tap mechanism is not used, because it installs into the user-writable skills dir, needs Git, and has different auth.

**D8. New identity.** Publisher `rangeltech`, package name to be confirmed unique, commands/views/settings under `hermesRangelTech.*`. The upstream coexistence guard is replaced by one that detects the two known upstream IDs and warns. The upstream publish workflow and its OIDC bindings are removed, not edited.

**D9. Pin, don't float.** Each extension release pins exactly one Hermes runtime (tag plus commit SHA plus bundle SHA-256). A nightly canary job runs the smoke test against the newest upstream tag and opens an issue on failure. Bumping the pin is a normal reviewed change.

**D10. Windows is a first-class target from M1.** CI runs the full suite on Windows and Linux. Windows-only code paths (process-tree kill, path handling, spaces and non-ASCII in the user profile name) get their own tests.

---

## 5. Component design

Proposed layout (adds to the upstream tree, minimizes edits to `chatPanel.ts`, `sessionManager.ts` and `webview/`):

```
src/
  paths/HermesHome.ts            single source for every path under HERMES_HOME and data dir
  runtime/
    RuntimeManifest.ts           schema + parser for the embedded manifest
    RuntimeResolver.ts           decides which runtime to use (mode, active pointer)
    RuntimeValidator.ts          runtime.json check, --version, --check, hash report
    RuntimeInstaller.ts          download, verify, extract, switch (atomic)
    RuntimeProcess.ts            builds exe/args/env, tree-kill
    RuntimeLock.ts               cross-window install lock
  providers/
    ProviderProfile.ts           profile model (no secrets)
    ProviderManager.ts           CRUD, active profile, config generation
    HermesConfigWriter.ts        wraps `hermes config set`
    ConnectionTest.ts            HTTP probe with classified errors
  secrets/SecretManager.ts       SecretStorage wrapper, redaction registry
  skills/
    GithubTarball.ts             conditional fetch, streaming extract
    SkillsMirror.ts              staging dir, atomic swap, state file
    SkillsSyncService.ts         triggers, timeouts, status
  ui/
    SetupWizard.ts  RuntimePanel.ts  ProvidersPanel.ts  SkillsPanel.ts
  test/fakes/
    FakeAcpAgent.ts  MockOpenAIServer.ts
```

### 5.1 HermesHome

One module returns the data dir, the `HERMES_HOME` for the current mode, and every derived path (`config.yaml`, `skills/`, `role-runs/`, `models_dev_cache.json`, `default_profile_name`). All callers listed in section 2.3 switch to it. This is the first code change in M1 and needs no runtime work, so it de-risks the rest.

Data dir: `%LOCALAPPDATA%\HermesByRangelTech` on Windows, `${XDG_DATA_HOME:-~/.local/share}/hermes-by-rangel-tech` on Linux (product spec §29). Contains `runtime/`, `home/`, `skills/`, `cache/`, `logs/`, `state/`.

### 5.2 Runtime manager

Modes: `automatic`, `portable`, `existing` (product spec §7).

```
resolve(mode) -> ResolvedRuntime | RuntimeError
  automatic : state/active.json -> runtime/<id>/ ; missing -> install prompt
  portable  : configured folder ; must contain runtime.json
  existing  : configured binary ; validated with --version only
ResolvedRuntime { id, root, exe, args[], envAdditions, source }
```

Runtime install (automatic mode):

1. Acquire `state/runtime.lock` (atomic `mkdir`, PID and timestamp inside, stale after 10 min without heartbeat). Two VS Code windows on first run must not both download.
2. Download to `cache/<id>.partial` with HTTP range resume, HTTPS only, redirects allowed only to the same manifest-pinned host set, proxy from VS Code settings.
3. Verify SHA-256 against the embedded manifest. Mismatch deletes the file and fails, no retry loop on a bad hash.
4. Extract to `runtime/<id>.staging/`. Reject entries with `..`, absolute paths or symlinks that leave the root.
5. Run the validator against the staging dir.
6. Rename `<id>.staging` to `<id>`, then atomically write `state/active.json`.
7. Keep the previous runtime. Delete all but the two newest after the next successful start.

Never switch `active.json` while a session is active. Updates apply on the next restart the user chooses.

Validator (also used for portable folders), in order, first failure stops:

1. `runtime.json` present, schema valid, `platform` and `arch` match the host.
2. Entry executable exists.
3. `exe --version` exits 0 within 10 s.
4. `exe --check` prints `Hermes ACP check OK` within 30 s.
5. On any failure: log the executable path and SHA-256, and show them in the error UI so the user can request an EDR/AppLocker exception (product spec §25). Never attempt to bypass a block.

### 5.3 Process launch

`RuntimeProcess` builds the child environment explicitly instead of inheriting blindly:

- Set: `HERMES_HOME`, `PYTHONUTF8=1`, `PYTHONNOUSERSITE=1`, `PYTHONDONTWRITEBYTECODE=1`, `HERMES_ACP_SKIP_CONFIGURED_MCP=1` [assumption: we want this; confirm in S4], provider key variables.
- Remove: `PYTHONHOME`, `PYTHONPATH`, `VIRTUAL_ENV`.
- Keep: `PATH` (plus runtime tool dirs), proxy variables, `SSL_CERT_*`, `SYSTEMROOT` and other Windows essentials.
- `spawn` without a shell, `windowsHide: true`, cwd is the workspace root.

Kill: on Windows use `taskkill /PID <pid> /T /F` (or a job object) so the Git Bash and tool children die. On Linux signal the process group. Escalate from graceful ACP shutdown to tree kill after 3 s. Covered by a test that spawns a grandchild and asserts it is gone.

### 5.4 Provider manager

Profile (stored in `globalState`, no secrets):

```
{ id, name, kind: 'openai-compatible', baseUrl, model, timeoutSeconds,
  headerNames: string[]   // values live in SecretStorage
}
```

Secrets in SecretStorage under `hermesRangelTech/profile/<id>/apiKey` and `.../headers`. The environment variable name passed to Hermes is derived from the profile id, so switching profiles switches which variable is set.

On start (or profile switch, which needs a restart of the agent process, as the upstream already does for profiles):

1. `HermesConfigWriter` writes `providers.custom` for the active profile and sets `model`, using `${HERMES_RT_KEY_<id>}` for `api_key`.
2. `RuntimeProcess` adds that variable to the child env, read from SecretStorage at spawn time only.
3. Extra header values that are secret get the same treatment through `${...}` in `extra_headers`.

Rules: `baseUrl` must be `https://` unless the host is loopback or the user ticks an explicit "allow insecure HTTP" per profile. URLs containing credentials (`user:pass@`) are rejected.

**Connection test** runs in the extension host, not through Hermes:

| Step | Request | Pass condition | Error classification |
|---|---|---|---|
| 1 Reach | `GET {base}/models` | any HTTP response | DNS, connection refused, TLS (with a hint about corporate TLS inspection), timeout |
| 2 Auth | same response | not 401/403 | "HTTP 401: check the API key for <name>" |
| 3 Model | `/models` body | id present, or `/models` is 404 (some servers omit it) | "model not listed", lists a few available ids |
| 4 Inference | `POST {base}/chat/completions`, `max_tokens: 8`, non-streaming | 200 with a choice | 4xx body summary (secrets redacted), 429, 5xx |

All requests carry the profile's timeout and headers. The Authorization header is registered with the log redactor before the first request.

### 5.5 Skills mirror (v0.2)

Pull-only, no Git:

1. Conditional `GET /repos/{owner}/{repo}/tarball/{ref}` with `If-None-Match`. A 304 ends the sync in one request, so "sync on startup" is cheap and safe under the unauthenticated 60 requests per hour limit.
2. Stream-extract into `skills/repos/<id>.staging/`, keep only `<skillsPath>/`, then swap directories atomically.
3. Write `.sync-state.json`: `{ etag, commitSha, fileHashes }`.
4. Ensure the mirror path is present in `skills.external_dirs` through the config writer. Idempotent.
5. Timeout 20 s. On any failure keep the previous mirror and report status. Never block agent start beyond that timeout ("sync before Hermes starts").

Private repos use a PAT from SecretStorage in an `Authorization` header. The token is never placed in a URL. Conflict states (product spec §16) only matter once push exists (v0.3). In v0.2 the mirror is read-only, and a hash comparison detects the user editing it by hand and warns instead of overwriting silently.

Surface in the UI which mirrored skills are shadowed by a same-named local skill, since local wins.

### 5.6 Setup wizard

Runs on first activation and from a command. Steps map to the product spec §6: runtime mode, provider profile with **Test connection** (must pass or be explicitly skipped), optional skills (disabled until v0.2), Start. It only calls the components above, holding no logic of its own, so every step is also reachable from settings panels.

---

## 6. Runtime build and distribution

### 6.1 Pipeline

A dedicated workflow, `runtime-build.yml`, per platform (`win32-x64`, `linux-x64`) on native runners:

1. Check out the pinned Hermes tag and record the commit SHA.
2. Run Hermes's official setup into a staging root with custom home and install dir, with the `acp` extra.
3. Record the versions and hashes it installed (from `pm/lock.json`), and generate `runtime.json`.
4. Run the validator (`--version`, `--check`).
5. Run the smoke test: start `acp_adapter.entry`, connect the fake ACP client, run one prompt against `MockOpenAIServer`, assert streamed output and one tool call round trip.
6. Archive (`zip` on Windows, `tar.gz` on Linux), compute SHA-256, enforce the size budget.
7. Generate an SBOM from the lock data and the installed package list.
8. Upload to a GitHub Release tagged `runtime-<hermesTag>-<buildN>`. Release notes list the pinned inputs.

### 6.2 Windows specifics

Git Bash must be resolvable by `pm.shell()` from the bundle (spike S5). Two ways to satisfy it, decided after S5:

- **Bundled:** PortableGit inside the runtime. Simple and offline-capable, but redistributes GPL software (section 9).
- **By reference:** the runtime records the Git artifact (URL plus SHA-256 taken from Hermes's `pm/lock.json`) and the installer fetches it at install time. No redistribution, but an extra download that a locked-down network may block, so the offline bundle for portable mode still includes it.

### 6.3 `runtime.json` contract

The extension depends only on this file, never on the bundle's internal layout.

```json
{
  "schema": 1,
  "id": "hermes-2026.9.24-b1",
  "hermes": { "tag": "v2026.9.24", "commit": "<sha>" },
  "platform": "win32", "arch": "x64",
  "acpProtocolVersion": 1,
  "entry": { "exe": "python/python.exe", "args": ["-m", "acp_adapter.entry"] },
  "cli":   { "exe": "python/python.exe", "args": ["-m", "hermes_cli.main"] },
  "env":   { "PATH_PREPEND": ["tools/bin"] },
  "inputs": { "python": "3.14.7+20260901", "uv": "0.12.3", "git": "2.53.0+3" }
}
```

Paths are relative to the runtime root. The validator rejects absolute paths and `..`.

### 6.4 Embedded manifest

`runtime-manifest/manifest.json` is bundled into the VSIX at package time and lists, per platform: runtime id, URL (fixed release host), SHA-256, size, and `minExtensionVersion`. Trust therefore comes from the signed, Marketplace-delivered VSIX. No network fetch is needed to decide what to download.

An optional remote update check (product spec §8, "Notify me") fetches a small JSON from the same release host and verifies an ed25519 signature with a public key embedded in the extension. It can only announce that a newer extension or runtime exists. It cannot change what gets executed without a new VSIX. This is deferred to v0.2.

### 6.5 Air-gapped path

Each release publishes the runtime archive and a `.sha256` file next to the VSIX. Portable mode accepts either an extracted folder or the archive, validates it as in section 5.2, and prints the archive hash for the user's own approval process.

### 6.6 Budget

Size is unmeasured [assumption, spike S8]. Working budget: 400 MB compressed per platform, 1.5 GB extracted. If the measurement exceeds it, drop optional Hermes components (voice, wake, browser, web dashboard) at build time. First-run time on a typical corporate link is a release criterion, not a nice-to-have.

---

## 7. Spikes (M0): prove before building

Each spike has a pass criterion. All ten are blocking for M2 onward, except where noted. Record results in `docs/spikes.md`.

| # | Question | How | Pass criterion | If it fails |
|---|---|---|---|---|
| S0 | **PASS.** Does Hermes ACP run natively on Windows x64 with no WSL and no admin, from a custom `HERMES_HOME`/install dir, without touching user PATH? | Run the official setup in a disposable Windows VM or clean user account with `-HermesHome`/`-InstallDir`. | `--check` OK and one prompt round trip with a mock OpenAI server. | Windows v0.1 is at risk. Escalate to Lucas before anything else. |
| S1 | **FAIL, D3 revised (see [spikes.md](spikes.md)).** Does the installed tree survive being moved to another absolute path? | Build at `C:\stage\x`, move to a path with spaces and non-ASCII, run `--check` and the smoke test. | Works unchanged. | Adopt D3b. |
| S2 | **PASS with `model.api_key: ${VAR}`.** Is an API key supplied only as a process env var honored via `${VAR}` in `providers.custom`, with no `.env` file? | Generate config, spawn with env, call a mock endpoint, assert the Authorization header. | Header received; nothing key-like written to disk. | Write a `0600`-equivalent `.env` inside the private home, document the tradeoff, add cleanup on profile removal. |
| S3 | **PASS.** Can `hermes config set` express `providers.custom` and `model` for a custom endpoint, and what is the exact model-string syntax? | Drive it against a scratch home, then read back with `config get`/`check`. | Round trip works, `resolve_runtime_provider()` selects it. | Comment-preserving YAML edit in TypeScript, with schema tests. |
| S3b | Does Qwen behind the real endpoint stream correctly, and does its `message.reasoning` surface as ACP thought chunks? | Real endpoint from the `qwen` skill (instance must be powered on). | Streaming works, reasoning arrives in a separate block. | Document the limitation, add the request option in the provider profile (extra body). |
| S4 | Which ACP behaviors change with `HERMES_ACP_SKIP_CONFIGURED_MCP` and with an empty home? | Compare initialize and session/new responses both ways. | Clean start, no MCP servers from a stale config. | Decide the default from the result. |
| S5 | **PASS.** Does `pm.shell()` find a bundled Git Bash under a custom `HERMES_HOME`, and does the terminal tool then work? | Run a `terminal` tool call in the smoke test on Windows. | Command executes through the bundled bash. | Investigate PM store layout; if unresolvable, ship a Hermes patch request upstream and gate Windows terminal features. |
| S6 | Does `skills.external_dirs` load a read-only mirror, and how are conflicts reported? | Point at a read-only dir with two skills, one shadowed. | Both visible to the agent, shadowing behaves as documented. | Fall back to copying into the local skills dir with a manifest of managed files. |
| S7 | Can the runtime execute from `%LOCALAPPDATA%` on the target corporate machines (AppLocker, WDAC, EDR)? | Run the validator on two corporate Windows machines and one Linux. | Passes, or fails with an actionable path and hash. | Document per policy. Nothing is bypassed. |
| S8 | Real size and first-run time of the bundle. | Measure the S1 build. | Within the section 6.6 budget. | Trim components. |
| S9 | Do concurrent VS Code windows sharing one private `HERMES_HOME` corrupt state? | Two extension hosts, two sessions, same home. | No lock errors or lost sessions. | One home per window/workspace, or a single-instance broker. |
| S11 | How do we stop Hermes from self-updating at startup, writing the user PATH, and installing default tools (`agent-browser`, `cua-driver`) from the network? Can the install be ACP-only? | Test `pm install --without`, config keys, install from tag. | Cold start offline, PATH untouched, size within budget. | Cannot ship an offline runtime; escalate. |
| S10 | Proxy and TLS inspection: does the extension host's download and probe honor VS Code proxy and system certificates, and does Python-side `truststore` cover the LLM call? | Test behind an intercepting proxy. | Both work. | Add explicit proxy and CA settings to the provider profile. |

S0 and S1 run first. S0 failing changes the project scope, and S1 decides D3 versus D3b.

---

## 8. Work plan

Milestones are ordered by dependency. Sizes are relative (S, M, L), not calendar estimates.

### M0: Spikes (S)
Section 7. Exit: `docs/spikes.md` has a result for every spike and decisions D3, D5 and the Windows Git strategy are confirmed or replaced.

### M1: Fork hygiene and identity (M)
- Create the repository, keep history, add `upstream` remote.
- Rename package, publisher, commands, views, settings to `hermesRangelTech.*`. Provide a one-time settings migration from `hermes.*` that runs only for keys the user has set.
- Replace the coexistence guard (D8). Remove upstream publish workflows.
- `LICENSE` and `NOTICE` with both upstream copyright lines and the "community project, not endorsed by Nous Research" statement.
- Introduce `HermesHome` and route every path in section 2.3 through it.
- Fix the POSIX defects: `where`/`which` split, `path.delimiter`, process-tree kill.
- Make the two symlink tests skip on `EPERM` with a clear message.
- Exit: CI green on Windows and Linux, existing behavior unchanged when `hermesRangelTech.runtime.mode = existing`.

### M2: Runtime abstraction (M)
- `RuntimeResolver`, `RuntimeValidator`, `RuntimeProcess`, `RuntimeLock`. Modes `existing` and `portable`.
- Runtime panel and the actionable error UI (path, hash, retry, select portable).
- `FakeAcpAgent` and integration tests for spawn, kill, crash, restart.
- Exit: a manually built runtime folder runs the agent from a path with spaces, and every failure in section 5.2 produces its specific message.

### M3: Runtime pipeline and automatic mode (L, starts right after M0, parallel to M2 and M4)
- `runtime-build.yml` per section 6, the `runtime.json` contract, embedded manifest, size and SBOM checks.
- `RuntimeInstaller` per section 5.2 with resume, hash check, safe extract, atomic switch, cross-window lock.
- Nightly canary against the newest Hermes tag.
- Exit: on a clean Windows user account with no admin, install the VSIX, run the setup, the runtime downloads and passes the validator, and an ACP round trip works.

### M4: Provider manager and wizard (M)
- Profile model, SecretStorage, `HermesConfigWriter`, env injection at spawn, connection test with all four steps and classified errors.
- Setup wizard and provider panel. Profile switch restarts the agent, using the existing restart flow.
- Replace hard-coded model catalogs with what ACP and the profile report.
- Log redaction registry with tests that assert a key never appears in the output channel or files.
- Exit: product spec §39 steps 4 to 10 against the real Qwen endpoint and against `MockOpenAIServer` in CI.

### M5: Platform hardening and corporate validation (M)
- Spike results S7, S9, S10 turned into fixes and docs.
- Test matrix: Windows corporate #1 and #2, Linux corporate, paths with spaces and non-ASCII usernames, no network after install, download blocked then portable fallback.
- `docs/edr-and-policy.md` documents observed incompatibilities.
- Exit: product spec §39 "Windows locked-down", "Runtime download blocked" and "Linux" pass on real machines.

### M6: Skills sync, pull-only (M)
- Section 5.5, settings and panel, sync on startup and before launch, status UI, shadowing report.
- Exit: product spec §40 with three machines, including a private repo with a PAT, and no token in logs or settings.

### M7: Beta (S)
- `0.1.0-beta` VSIX and runtime archives as GitHub Release assets, checksums, install docs, offline guide.
- Marketplace publication only after the beta feedback (product spec §43 phase 7).
- Exit: definition of done in product spec §45 that applies to v0.1.

Note on ordering versus the product spec: it lists skills as v0.2 and puts the runtime before providers. This plan keeps those scopes but runs M3 and M4 in parallel, because M3 is the schedule risk.

---

## 9. Licensing and trademark

- Extension: MIT, two upstream copyright lines preserved, our own line added.
- Hermes Agent: MIT. Redistribution requires the license text, included in the runtime archive under `licenses/`.
- Python (python-build-standalone), uv, ripgrep: permissive. Include their notices.
- **PortableGit is GPLv2.** Bundling it means offering the corresponding source and shipping the license text. Fetching it by reference from the Git for Windows release avoids redistribution. Decided: bundle (section 11, item 5).
- Python wheels in the venv carry their own licenses. The build emits a third-party notices file from the installed package metadata, and the release gate fails on an unknown or missing license.
- Name: the product name contains "Hermes", which is Nous Research's product name. The README and Marketplace listing must carry "community project, not affiliated with or endorsed by Nous Research". Check their trademark policy before Marketplace publication. This is a real risk to the product name, not a formality.

---

## 10. Security, privacy and test strategy

### 10.1 Threat model, condensed

| Threat | Control |
|---|---|
| Tampered runtime download | HTTPS, fixed host, SHA-256 from the VSIX-embedded manifest, safe extraction, validator before activation. |
| Malicious workspace changes launch settings | All runtime, provider and skills settings are user/machine scoped and ignored at workspace scope (upstream pattern, extended to every new setting). |
| Secret leakage | SecretStorage only. Env var injected at spawn. Redaction registry on all logs. No secrets in `settings.json`, session history, config files (subject to S2), or URLs. |
| Rogue skills repo runs code | Skills are agent instructions plus scripts Hermes may execute. First sync of a repository requires an explicit confirmation showing the repo and ref. Docs state the risk plainly. |
| Over-broad PAT | UI text and docs say: fine-grained token, single repo, Contents read-only. |
| Executable blocked by EDR | Fail clearly with path and hash. No bypass logic. |
| Supply chain of the extension itself | Lockfiles, `npm audit` gate (already in upstream `verify`), Dependabot, CodeQL, release provenance, SBOM. |

Prompt and file contents go to whichever provider the user configures, and to nobody else. Rangel Tech runs no proxy. There is no telemetry in v0.1.

### 10.2 Tests

| Layer | What | Where |
|---|---|---|
| Unit | Manifest parsing, path safety, redaction, config writer, connection-test classification, tarball extraction limits | every PR, Windows and Linux |
| Integration | `FakeAcpAgent` (initialize, session/new, streaming, tool calls, permission requests, crash, slow start) against the real `AcpClient` and `SessionManager` | every PR |
| Contract | Real runtime plus `MockOpenAIServer`: prompt, stream, tool call, cancel, terminal tool | runtime-build job and nightly canary |
| Upstream regression | All 23 existing test files stay green | every PR |
| Manual | Real Qwen endpoint, corporate machines, air-gapped install | before each beta |

Real credentials (the Qwen endpoint key, PATs) are never used in CI. The Qwen instance costs money while running, so it is powered on only for manual validation.

---

## 11. Decisions (resolved 2026-09-28)

| # | Topic | Decision |
|---|---|---|
| 1 | Repository | `LucasRangelSSouza/hermes-vscode`, **public**. Detached copy with upstream history, `upstream` remote points to `stefanpieter/hermes-vscode`. |
| 2 | Publisher | Personal publisher (Lucas), not an organization. The publisher ID is still to be created on the Marketplace and Open VSX, and `package.json` carries a placeholder until then. Not blocking before M7. |
| 3 | Runtime hosting | GitHub Releases of this repository. |
| 4 | Hermes pin | The newest release that passes S0 to S5. Current candidate: `v2026.9.24`. "Newest" is a candidate until the spikes prove it works, and a newer tag replaces it if one appears first and passes. |
| 5 | Git on Windows | **Bundle PortableGit** in the Windows runtime. This means shipping the GPLv2 text and a written source offer with the archive (section 9). |
| 6 | Test hardware | Windows: the development machine (a disposable local user account for S0/S1, so the primary profile stays untouched). Linux: Docker. Docker is a clean-room check but does not cover corporate EDR/AppLocker behavior, so S7 stays open until a corporate Windows machine is available. |
| 7 | Name | Public repository, so the "Hermes" name is used, with the "community project, not affiliated with or endorsed by Nous Research" disclaimer in the README and listing. Re-read their trademark policy before the Marketplace listing (M7). |

Consequences already folded into the plan: section 6.2 uses the bundled option, M5 runs Windows tests on the dev machine and Linux tests in a container, and R4/S7 remain risks until a policy-restricted machine is tested.

---

## 12. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Native Windows Hermes is early beta and ACP or the terminal tool misbehaves | Medium | High | S0 and S5 first. Escalate before investing in Windows-specific work. |
| R2 | Hermes internals keep shifting | High | Medium | D6 (ACP only), D9 (pin plus canary), no imports of Hermes modules. |
| R3 | Bundle is not relocatable, or `pm` assumes its own store | Medium | High | S1, S5, fallback D3b. |
| R4 | Corporate policy blocks execution from user-writable paths (AppLocker/WDAC) | Medium | High | Documented precondition (product spec §39), clear failure UX, path and hash for approval. Cannot be fixed in software. |
| R5 | AV flags `uv.exe` or the unsigned Python | Medium | Medium | Ship the venv, not uv, at runtime where possible. Report path and hash. Consider code-signing later. |
| R6 | Bundle too large for slow corporate links | Medium | Medium | S8 budget, component trimming, resumable download, offline archive. |
| R7 | Env-only secrets are not honored | Low to medium | Low | S2 fallback with private-home `.env`. |
| R8 | Maintenance burden of a ~10.8k-line fork | Medium | Medium | Keep our code in new modules, keep `upstream` remote, merge regularly, fallback D1. |
| R9 | Concurrent windows corrupt shared state | Low to medium | Medium | S9, per-workspace home if needed, install lock. |
| R10 | The product name draws a trademark objection | Low to medium | High | Section 9, check early, disclaimers, keep the name a one-line change. |
| R11 | Marketplace review objects to download-and-execute | Low | Medium | Fixed host, hash pinned in the VSIX, disclosed in the listing, VSIX-only distribution as fallback (already planned). |

---

## 13. Acceptance mapping

| Product spec | Proven by |
|---|---|
| §39 Windows locked-down (steps 1 to 11) | M3 exit plus M4 exit, executed on real corporate hardware in M5 |
| §39 Runtime download blocked | M2 portable mode plus M5 test |
| §39 Linux | M3 and M5 on Linux |
| §40 Skills sync | M6 exit |
| §45 Definition of done for 1.0 | Not a v0.1 goal. Track open items in `docs/roadmap.md` after beta. |

---

## Appendix A. Sources

- Hermes docs: ACP host integration, installation, configuration, skills, Windows native guide (hermes-agent.nousresearch.com).
- `NousResearch/hermes-agent` at `main` and tag `v2026.9.24`: `pyproject.toml`, `pm/lock.json`, `setup-hermes.ps1`, `acp_adapter/entry.py`, `acp_adapter/auth.py`, `COMPAT_MANIFEST.md`.
- `stefanpieter/hermes-vscode` at commit `105145d` (v3.6.0): source, `docs/releasing.md`, `docs/migration-from-original.md`, `.github/workflows/ci.yml`.
- Local run: `npm ci` and `npm test` on Windows 11, Node 24, 2026-09-28.

## Appendix B. ACP surface the extension uses today

`initialize {protocolVersion: 1}` · `session/new` · `session/load` (required so the adapter registers a resumed ID) · `session/prompt` · `session/cancel` (notification) · `session/set_mode` · agent-to-client `session/request_permission`. Streaming arrives as `session/update` notifications. `authenticate` and `session/set_model` are not used by the upstream and need checking in S3 and S4 for headless provider setup.
