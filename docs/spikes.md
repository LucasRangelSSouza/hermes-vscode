# Spike results (M0)

Machine: Windows 11 Pro x64, Node 24, no admin. Date: 2026-09-28. Hermes: `main` at `8f2160611` (`0.21.5+4151`), installed with the official `install.ps1`.
Scripts used are in [spikes/s0/](spikes/s0/): a mock OpenAI server and a minimal ACP client.

| Spike | Result | Evidence |
|---|---|---|
| **S0** Native Windows ACP, no WSL, no admin, custom home | **PASS** | `install.ps1 -HermesHome <dir> -InstallDir <dir>\hermes-agent -NonInteractive -SkipBrowser -SkipComputerUse` completes. `hermes-acp --version` prints `0.21.5+4151.g8f21606`, `--check` prints `Hermes ACP check OK`. ACP `initialize`, `session/new` and `session/prompt` work and stream (`agent_message_chunk`). |
| **S2** API key from process environment only | **PASS, with a different config** | With `provider: custom`, `OPENAI_API_KEY` is **ignored** (mock saw `Bearer no-key-required`). `model.api_key: ${HERMES_RT_KEY}` in `config.yaml` plus the variable in the child env is honored (mock saw the real value) and nothing key-like was written to disk. Unconfirmed: a 4-character key (`sk-x`) was also replaced by `no-key-required`, so Hermes may discard very short keys. |
| **S3** Provider config through `hermes config set` | **PASS** | `config set model.provider custom`, `model.base_url <url>`, `model.default <name>`, `model.api_key '${VAR}'` all work and read back with `config get model`. The `providers.custom` block from the docs is not needed. ACP then advertises auth methods `custom` and `hermes-setup`, so no terminal setup is required. |
| **S5** Terminal tool through bundled Git Bash | **PASS** | A `terminal` tool call returned `{"output":"hello-from-bash\nGNU bash, version 5.2.37(1)-release (x86_64-pc-msys)","exit_code":0}`. No permission prompt for a plain `echo`. Bash comes from PortableGit in `<home>\tools\git-2.53.0+3-win32-x64`. |
| **S1** Runtime survives a move to another path | **FAIL for the installed tree, PASS for the sealed payload (S1b)** | See below. |
| **S8** Size | **Measured, too big for one file** | Sealed core payload: 2,167 MB (Windows) and 2,039 MB (Linux) as `tar.gz`. See S8 below. |

Not yet run: S3b (real Qwen), S4, S6, S7, S9, S10.

## S1 in detail: the tree is not relocatable

The tree was moved from `...\hermes-spike\home` to `...\hermes-spike\mov ção teste\hermes home`.

1. `bin\hermes-acp.exe` exits 1 with no output. The shim runs `python.exe -I -c <base64 stub>` and the stub hardcodes the absolute `hermes-agent` path. This confirms decision D4 (launch through the interpreter).
2. Launching the same code through our own stub from the new path **works, but Hermes first runs a full self-update cycle**: it "completes source-update dependencies", reinstalls Python dependencies, runs `npm ci` (which failed in this path), then installs `agent-browser` and `cua-driver` from the network. The `--check` took 2 min 9 s and only passed because this machine has internet. On an offline or restricted machine it would hang or fail.
3. That cycle also **modified the user PATH again** (added the new `bin` directory). The PATH was restored from a backup both times.
4. Absolute paths are stored in: both `pyvenv.cfg` files, `direct_url.json`, `facts.json`, the editable-install finder script, `state.db`, uv interpreter caches and a terminal snapshot script, plus stdlib `.pyc` files (harmless).

Consequences for the design:

- An installer-built tree cannot be shipped and moved. A text rewrite is fragile because `state.db` and PM state are in the list. This finding led to the S1b test below, which found a workable route: Hermes's own sealed-payload build lane.
- The source of the self-update is `hermes_cli/venv_sync.py`: it only runs when the install stamp says `updateMechanism: self`. Sealed and `external` installs skip it and do not publish launchers or touch the PATH. This is what S1b relies on.

## S8 in detail: size of the installed tree

| Part | Size |
|---|---|
| `hermes-agent` (source, node dependencies, UI builds) | 726 MB |
| `tools\ffmpeg` | 428 MB |
| `tools\git` (PortableGit) | 399 MB |
| `installs` (Python venv with dependencies) | 391 MB |
| `tools\python` | 154 MB |
| `tools\node` | 115 MB |
| `tools\uv` | 47 MB |
| `tools\npm` | 17 MB |
| Total | 2.3 GB |

The 400 MB compressed budget in the development spec is unlikely to hold without dropping ffmpeg, node, the TUI and web builds. Whether the installer allows an ACP-only install is part of S11.

## Other findings

- The installer's default is `-Branch main`, so this install is main HEAD, not a release tag. Pinning `v2026.9.24` needs `-Branch`/`-Commit` (both exist). Pin by commit SHA.
- The installer writes the user PATH unconditionally (`Set-LauncherUserPath`). A managed runtime must not run it.

## S1b: the sealed payload from Hermes's own build lane (PASS)

The installed tree is not relocatable, but Hermes ships a build lane for sealed, relocatable payloads (used by its desktop bundle): `scripts/bundles/native_build.py` (the `hermes pm bundle` equivalent). It cannot run on this Windows machine because the `silk` extra compiles `pilk`, which needs the MSVC C++ Build Tools. It runs fine on GitHub's `windows-latest` and `ubuntu-latest` runners, so the build lives in CI.

Workflow: [runtime-spike.yml](../.github/workflows/runtime-spike.yml). Run `36447852474`, Hermes tag `v0.21.4+canary.20260928T071354Z` (commit `8f2160611`), mode **core**:

| Check | Windows | Linux |
|---|---|---|
| Build | 902 s | 206 s |
| Payload moved to `.../mov ção teste/payload` (spaces and non-ASCII) | ok | ok |
| Network cut (`HTTP(S)_PROXY` and `ALL_PROXY` to a dead port) | ok | ok |
| `hermes-acp --version` | 0.43 s | 0.64 s |
| `hermes-acp --check` | `Hermes ACP check OK` in 1.1 s | `Hermes ACP check OK` in 1.5 s |
| `hermes config set model.*` | ok | ok |
| ACP round trip, streamed text | `Hello from the mock.` | same |
| Terminal tool | bash 5.2.37 (msys, from PortableGit) | bash 5.2.21 (system) |
| API key delivered from env only (`Bearer no-key-required` never seen) | ok | ok |

No self-update, no dependency install, no network use on start. This resolves S1 and most of S11. Not yet verified for the payload: that it leaves the user PATH untouched (the CI runner cannot show that). Check it locally with a PATH backup before relying on it (S11b).

Two behaviors of the Hermes build lane worth knowing:

- **Frontends (`stage`, "full" mode) fail on this canary.** The web build needs the Node workspace installed inside the checkout (`node scripts/build/node-deps.mjs --source . --workspace ui-tui --workspace web`), and then the bytecode step fails with `ValueError: 2077 payload modules have no bytecode pyc`. This is on Hermes's side. The TUI and web dashboard are not used by a VS Code extension, so the plan ships the core payload and revisits frontends only if a need appears.
- **Version scheme.** Hermes now cuts daily canary tags (`v0.21.4+canary.<timestamp>`). The older calver releases (`v2026.9.x`) do not have `scripts/bundles` at all. We pin an exact canary tag and commit that passed this workflow.

## S8 in detail: sealed core payload size

| Part | Windows | Linux |
|---|---|---|
| `tools` | 3.6 GB | 2.9 GB |
| `venv` | 1.3 GB | 1.5 GB |
| `uv-cache` | 994 MB | 2.5 GB |
| `hermes-agent` | 127 MB | 135 MB |
| `pm-runtime` | 2.4 MB | 2.5 MB |
| **`tar.gz` total** | **2,167 MB** | **2,039 MB** |

`tools` holds the add-ons: Chromium, `agent-browser`, `cua-driver`, ffmpeg, four llama.cpp builds (cpu, cuda, hip, vulkan), `gh`, `bws`, node, npm, PortableGit, ripgrep, uv and Python. `uv-cache` is the retained wheel cache for offline rebuilds of a mutable environment, not needed to run.

Decision (2026-09-28, from Lucas): ship the complete system with all add-ons. One `tar.gz` is above GitHub's 2 GB per-file limit, so the runtime is split into packs (section 6.7 of the development spec). Per-part compressed sizes are not measured yet: that is the first task of the pipeline work.
