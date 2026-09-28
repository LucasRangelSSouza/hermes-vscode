# Spike results (M0)

Machine: Windows 11 Pro x64, Node 24, no admin. Date: 2026-09-28. Hermes: `main` at `8f2160611` (`0.21.5+4151`), installed with the official `install.ps1`.
Scripts used are in [spikes/s0/](spikes/s0/): a mock OpenAI server and a minimal ACP client.

| Spike | Result | Evidence |
|---|---|---|
| **S0** Native Windows ACP, no WSL, no admin, custom home | **PASS** | `install.ps1 -HermesHome <dir> -InstallDir <dir>\hermes-agent -NonInteractive -SkipBrowser -SkipComputerUse` completes. `hermes-acp --version` prints `0.21.5+4151.g8f21606`, `--check` prints `Hermes ACP check OK`. ACP `initialize`, `session/new` and `session/prompt` work and stream (`agent_message_chunk`). |
| **S2** API key from process environment only | **PASS, with a different config** | With `provider: custom`, `OPENAI_API_KEY` is **ignored** (mock saw `Bearer no-key-required`). `model.api_key: ${HERMES_RT_KEY}` in `config.yaml` plus the variable in the child env is honored (mock saw the real value) and nothing key-like was written to disk. Unconfirmed: a 4-character key (`sk-x`) was also replaced by `no-key-required`, so Hermes may discard very short keys. |
| **S3** Provider config through `hermes config set` | **PASS** | `config set model.provider custom`, `model.base_url <url>`, `model.default <name>`, `model.api_key '${VAR}'` all work and read back with `config get model`. The `providers.custom` block from the docs is not needed. ACP then advertises auth methods `custom` and `hermes-setup`, so no terminal setup is required. |
| **S5** Terminal tool through bundled Git Bash | **PASS** | A `terminal` tool call returned `{"output":"hello-from-bash\nGNU bash, version 5.2.37(1)-release (x86_64-pc-msys)","exit_code":0}`. No permission prompt for a plain `echo`. Bash comes from PortableGit in `<home>\tools\git-2.53.0+3-win32-x64`. |
| **S1** Runtime survives a move to another path | **FAIL** | See below. |
| **S8** Size | **Partial** | Installed tree is 2.3 GB (see below). The ACP-only minimum is not measured yet. |

Not yet run: S3b (real Qwen), S4, S6, S7, S9, S10, S11.

## S1 in detail: the tree is not relocatable

The tree was moved from `...\hermes-spike\home` to `...\hermes-spike\mov ção teste\hermes home`.

1. `bin\hermes-acp.exe` exits 1 with no output. The shim runs `python.exe -I -c <base64 stub>` and the stub hardcodes the absolute `hermes-agent` path. This confirms decision D4 (launch through the interpreter).
2. Launching the same code through our own stub from the new path **works, but Hermes first runs a full self-update cycle**: it "completes source-update dependencies", reinstalls Python dependencies, runs `npm ci` (which failed in this path), then installs `agent-browser` and `cua-driver` from the network. The `--check` took 2 min 9 s and only passed because this machine has internet. On an offline or restricted machine it would hang or fail.
3. That cycle also **modified the user PATH again** (added the new `bin` directory). The PATH was restored from a backup both times.
4. Absolute paths are stored in: both `pyvenv.cfg` files, `direct_url.json`, `facts.json`, the editable-install finder script, `state.db`, uv interpreter caches and a terminal snapshot script, plus stdlib `.pyc` files (harmless).

Consequences for the design:

- Decision D3 (ship a built tree and just move it) is dead. Use **D3b**: ship the pinned inputs and produce the tree at its final path on the client, offline. A rewrite step is fragile because `state.db` and PM state are in the list.
- New blocking question, **S11**: how to stop Hermes from self-updating and from writing the user PATH at startup. Candidates to test: `hermes pm install --without agent-browser --without cua-driver` (recorded in `declined-packages.json`), an update-check setting in `config.yaml`, and installing from the release tag instead of `main`.

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
