# Hermes by Rangel Tech

A community VS Code integration for [Hermes Agent](https://hermes-agent.nousresearch.com). Install the extension, connect your model and start coding. The extension downloads and manages the Hermes runtime for you, so you do not install Python, Node, Git or Hermes yourself.

> **Community project.** Not affiliated with, endorsed by or sponsored by Nous Research. Hermes Agent is their product; this extension only integrates it with VS Code.

It is derived from the MIT-licensed [`hermes-vscode`](https://github.com/stefanpieter/hermes-vscode) client (originally by Joao Peixoto). See [NOTICE](NOTICE).

## What you get

- Streaming Hermes chat in the VS Code sidebar, with reasoning, tool calls, todos and usage.
- A **managed runtime**: on first use the extension downloads a pinned, hash-verified Hermes runtime from this repository's GitHub Releases into your user folder. No administrator rights, no system installs.
- A **provider wizard** for any OpenAI-compatible endpoint (base URL, model, API key) with a connection test that explains what is wrong.
- Your API key stays in VS Code **Secret Storage**. It is handed to Hermes only as a process environment variable, never written to a file, a setting or a log.
- Multiple persistent conversations, edit approvals, permission prompts, image paste, file references and slash commands.
- Windows x64 and Linux x64.

## Install

1. Download `hermes-by-rangel-tech-<version>.vsix` from the [Releases](https://github.com/LucasRangelSSouza/hermes-vscode/releases) page.
2. In VS Code: **Extensions** → `…` → **Install from VSIX…**
3. Open the **Hermes** view in the activity bar. The first run asks to download the runtime, then walks you through the provider setup.

A trusted workspace is required. The extension stays disabled in Restricted Mode because it launches an autonomous agent with access to your workspace.

## First run

| Step | What happens |
|---|---|
| Runtime | A confirmation shows the download size, then installs to `%LOCALAPPDATA%\HermesByRangelTech` (Windows) or `~/.local/share/hermes-by-rangel-tech` (Linux). Nothing outside that folder is touched. |
| Provider | Enter a name, the base URL (for example `https://api.example.com/v1`), the model id and the API key. The extension tests the connection before saving. |
| Chat | Type in the sidebar. Hermes runs locally on your workspace; only the model calls go to your provider. |

Commands (Command Palette, prefix **Hermes:**): Setup, Configure Provider, Test Provider Connection, Install or Repair Runtime, Select Portable Runtime Folder, Show Runtime Status, Show Logs, New Session, Restart Agent.

## Networks that block the download

Some organizations block GitHub downloads. Then use a portable runtime:

1. On a machine with access, download the runtime archives for your platform from the release named `runtime-<id>` (each release lists them; the extension's **Show Runtime Status** command tells you which one it expects).
2. Extract all archives into one folder. It must contain `runtime.json`.
3. Run **Hermes: Select Portable Runtime Folder** and pick that folder. The extension validates it before using it.

If endpoint security blocks the runtime, the extension shows the executable path and its SHA-256 so you can ask IT for an exception. It never tries to bypass a security control.

## Settings

| Setting | Purpose |
|---|---|
| `hermesRangelTech.runtime.mode` | `automatic` (default), `portable` or `existing` |
| `hermesRangelTech.runtime.portablePath` | Folder used in portable mode |
| `hermesRangelTech.runtime.existingPath` | Hermes binary used in existing mode (advanced) |
| `hermesRangelTech.runtime.optionalPacks` | Optional runtime packs to install; the default installs everything |
| `hermesRangelTech.profile` | Hermes profile (existing mode) |
| `hermesRangelTech.editApprovalMode` | ACP file-edit approval mode |
| `hermesRangelTech.debugLogs` | Diagnostic ACP logs |

Settings that choose what executable runs are machine-scoped. A workspace cannot override them.

## Privacy and security

- Prompts, and file contents when Hermes needs them, go to **the provider you configured** and nowhere else. Rangel Tech runs no proxy and the extension has no telemetry.
- The only other network access is the runtime download from this repository's GitHub Releases.
- The runtime is verified against SHA-256 hashes embedded in the extension. A pack that does not match is deleted and nothing is installed. Downloads accept only HTTPS and GitHub release hosts.
- The extension keeps its own Hermes home; it does not read or change an existing `~/.hermes`.
- Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm run verify
```

`npm run verify` runs the type check, secret scan, tests, production build, dependency audit and VSIX packaging. See [docs/DEVELOPMENT_SPEC.md](docs/DEVELOPMENT_SPEC.md) for the design, [docs/spikes.md](docs/spikes.md) for the evidence behind it and [docs/releasing.md](docs/releasing.md) for how runtimes and releases are built.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
