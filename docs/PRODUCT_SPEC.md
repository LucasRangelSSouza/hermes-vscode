# Hermes by Rangel Tech — Product & Technical Specification

**Status:** Draft v0.1  
**Product:** Hermes by Rangel Tech  
**Type:** VS Code Extension  
**Goal:** Make Hermes Agent usable inside VS Code with a one-click/portable experience, including managed runtime, provider configuration and synchronized skills, without requiring a traditional local Hermes installation.

## 1. Context

The target environment includes Windows and Linux workstations where the user may be able to install VS Code extensions and execute binaries from user directories, but may not have permission to install system software. Some machines may also block runtime downloads.

The LLM inference can run remotely behind an OpenAI-compatible API. Hermes should remain local so it can access the local workspace, terminal, files, Git repository and tools.

Existing Hermes VS Code integrations generally assume one of the following:

- Hermes CLI already installed locally;
- Hermes available in `PATH`;
- user manually points to an existing Hermes binary;
- Hermes runs remotely, which weakens access to the local workspace.

This project removes that friction.

## 2. Product vision

The desired experience is similar to Claude Code or Roo Code:

1. Install the extension.
2. Open a setup wizard.
3. Choose/configure an LLM provider.
4. Configure skills synchronization if desired.
5. Let the extension provision or locate a portable Hermes runtime.
6. Start coding.

The user should not need to manually install Python, Node, Git, Hermes CLI, CUDA or local model weights.

## 3. High-level architecture

```text
VS Code
│
├── Hermes by Rangel Tech Extension
│   ├── UI / Webview
│   ├── Runtime Manager
│   ├── Provider Manager
│   ├── Skills Sync
│   ├── Secret Storage
│   ├── Session Manager
│   └── ACP Client
│
├── Portable Hermes Runtime
│   └── hermes acp
│
└── Remote LLM Provider
    ├── OpenAI-compatible API
    ├── Anthropic
    ├── OpenAI / Codex
    ├── Gemini
    └── other Hermes-supported providers
```

Primary flow:

```text
Local VS Code
    ↓
Extension
    ↓
Local portable Hermes
    ↓
ACP
    ↓
Remote LLM API
```

Hermes stays local. The LLM can stay remote.

## 4. Fork strategy

Start from the most mature open-source Hermes VS Code integration available, preferably one that already provides:

- sidebar chat;
- streaming;
- thinking/reasoning display;
- tool calls;
- approvals;
- diff rendering;
- session persistence;
- model/profile selection;
- ACP support;
- skills awareness;
- file navigation.

### Preferred base

Initial candidate: **Hermes AI Agent (Maintained)** / maintained Hermes VS Code ACP implementation.

Before implementation, verify:

- current repository URL;
- license;
- recent activity;
- UI maturity;
- ACP compatibility;
- compatibility with current Hermes releases;
- redistribution requirements.

### Fork requirements

The fork must:

- keep required upstream license/copyright notices;
- clearly state that it is a community project;
- not imply official Nous Research endorsement;
- document upstream attribution in `NOTICE`, `LICENSE` or equivalent files.

## 5. Branding

**Product name:** `Hermes by Rangel Tech`

Suggested Marketplace description:

> A community VS Code integration for Hermes Agent with managed portable runtime, provider setup and synchronized skills.

Suggested publisher: `Rangel Tech`

Preferred extension identifier:

```text
rangeltech.hermes
```

## 6. First-run experience

Example setup wizard:

```text
Welcome to Hermes by Rangel Tech

Runtime
[ Automatic ]
[ Portable runtime ]
[ Existing Hermes ]

Provider
[ OpenAI Compatible ▼ ]

Base URL
https://api.example.com/v1

API Key
••••••••••••••••

Model
Qwen3.8-27B-NVFP4

[Test Connection]

Skills Sync
[ Configure now ]
[ Skip ]

[ Start Hermes ]
```

After setup, open the normal Hermes sidebar.

## 7. Runtime Manager

The extension owns Hermes runtime discovery and lifecycle.

### Initial supported systems

- Windows x64
- Linux x64

Future:

- Windows ARM64
- Linux ARM64
- macOS

### Runtime modes

#### 7.1 Automatic runtime

The extension:

1. detects OS;
2. detects CPU architecture;
3. resolves compatible Hermes runtime version;
4. downloads the packaged runtime;
5. verifies checksum;
6. extracts into a user-writable directory;
7. starts Hermes through ACP.

Windows:

```text
%LOCALAPPDATA%\HermesByRangelTech\runtime\<version>\
```

Linux:

```text
~/.local/share/hermes-by-rangel-tech/runtime/<version>/
```

#### 7.2 Portable runtime

For corporate machines where downloads are blocked.

The user selects a local runtime directory. The extension validates it and stores the path.

Examples:

```text
D:\tools\hermes-portable\
~/tools/hermes-portable/
```

#### 7.3 Existing Hermes

Advanced users can point to an already installed Hermes binary.

## 8. Runtime version management

The extension must track:

- extension version;
- compatible Hermes runtime versions;
- active runtime version;
- platform/architecture;
- runtime checksum.

Example manifest:

```json
{
  "hermesVersion": "x.y.z",
  "builds": {
    "win32-x64": {
      "url": "https://...",
      "sha256": "..."
    },
    "linux-x64": {
      "url": "https://...",
      "sha256": "..."
    }
  }
}
```

Update modes:

```text
○ Automatic
● Notify me
○ Manual only
```

Default: **Notify me**.

Never replace a working runtime during an active session.

If the runtime already exists locally, the extension must keep working when the runtime download source is unavailable.

## 9. Runtime download security

Runtime download rules:

- fixed trusted release source;
- HTTPS only;
- version manifest controlled by the project;
- SHA-256 verification;
- optional signature verification;
- runtime version displayed to user;
- no arbitrary download-and-execute URL setting.

For custom runtimes, the user selects a local file/folder manually.

## 10. ACP integration

ACP is the primary extension-to-Hermes integration layer.

Expected lifecycle:

```text
extension
    ↓
spawn portable Hermes
    ↓
hermes acp
    ↓
stdio ACP transport
```

Required capabilities:

- create/resume session;
- send prompts;
- receive streaming responses;
- receive reasoning/thinking blocks when provided;
- display tool calls;
- handle permission requests;
- display file modifications;
- cancellation;
- error handling;
- session state where supported.

The extension must not reimplement the Hermes agent loop.

Hermes remains responsible for agent orchestration, tools, memory, skills and provider behavior.

## 11. Provider Manager

The extension provides graphical provider configuration.

### MVP provider

**OpenAI-compatible**

Fields:

```text
Profile Name
Base URL
API Key
Model
Optional Headers
Timeout
```

Example:

```text
Profile Name: Rangel Qwen
Base URL: https://llm.example.com/v1
API Key: ********
Model: qwen3.8-27b
```

### Connection test

Button:

```text
[Test Connection]
```

It should verify:

- endpoint reachable;
- authentication accepted;
- requested model usable;
- basic inference succeeds;
- clear error if it fails.

## 12. Multi-provider roadmap

Later versions should expose supported Hermes providers, including candidates such as:

- OpenAI-compatible;
- OpenAI;
- Anthropic;
- Gemini;
- OpenRouter;
- local endpoints;
- other Hermes-supported providers.

The extension should avoid duplicating provider logic already implemented by Hermes.

## 13. Secret management

Secrets must use **VS Code SecretStorage**.

Secrets include:

- LLM API keys;
- GitHub PAT;
- provider credentials;
- secret custom headers.

Do not store secrets in:

- `settings.json`;
- workspace files;
- Git repository;
- logs.

## 14. Skills synchronization

Skills synchronization is a first-class feature.

The user can maintain one GitHub repository containing Hermes skills and synchronize it across several computers.

### UI

```text
Skills Sync

Repository
https://github.com/user/hermes-skills

Branch
main

Skills Path
skills/

Authentication
[ GitHub Token ]

[Test Connection]
[ Sync Now ]

☑ Sync on VS Code startup
☑ Sync before Hermes starts
☐ Automatically push local changes
```

### Example repository

```text
hermes-skills/
├── skills/
│   ├── data-engineering/
│   ├── coding/
│   ├── terraform/
│   └── company/
└── README.md
```

The skills path must be configurable.

## 15. GitHub authentication

Public repositories:

- no token required for read-only sync.

Private repositories:

- GitHub Personal Access Token in MVP;
- GitHub OAuth later.

Token lives in SecretStorage.

Use least-privilege permissions.

Read-only sync should require only repository content read access. Push requires content write access.

## 16. Skills sync engine

Do not assume system Git is installed.

Possible implementations:

1. GitHub REST API;
2. embedded Git library;
3. bundled portable Git;
4. system Git as optional optimization.

Preferred MVP:

- GitHub API for read-only pull/sync;
- full Git push workflow later.

Initial mode:

```text
Pull only
```

Later:

```text
Bidirectional
```

### Conflict behavior

Never silently overwrite conflicting local skill changes.

Possible states:

```text
Clean
Remote changed
Local changed
Conflict
```

Conflict actions:

```text
Use Local
Use Remote
Open Diff
Cancel Sync
```

## 17. Hermes skills path

The synchronized skills directory should be made available to the local Hermes runtime.

Windows:

```text
%LOCALAPPDATA%\HermesByRangelTech\skills\
```

Linux:

```text
~/.local/share/hermes-by-rangel-tech/skills/
```

If Hermes safely supports using the repository checkout directly, that can be used instead.

## 18. Chat UI

Retain and improve the selected fork's existing UI.

Required capabilities:

- persistent sidebar;
- prompt input;
- Markdown rendering;
- syntax highlighting;
- code blocks;
- streaming;
- collapsible reasoning/thinking;
- tool call cards;
- file references;
- error rendering;
- stop button;
- session history.

## 19. Thinking / reasoning

If the selected model/provider returns reasoning separately, render it separately.

Example:

```text
Thinking ▸
```

Collapsed by default.

Never synthesize fake reasoning blocks.

## 20. Tool calls

Tool call cards should expose:

- tool name;
- status;
- duration;
- compact parameters;
- compact result;
- error state.

Examples:

```text
read_file
search_files
write_file
terminal
git
test
```

## 21. Approvals

Potentially destructive actions should support explicit approval using Hermes/ACP capabilities.

Example:

```text
Hermes wants to run:

rm -rf build/

[Allow once]
[Allow for session]
[Deny]
```

## 22. File changes and diffs

Example:

```text
Changed Files

src/api.ts      +21 -8
README.md       +5 -1

[Open Diff]
[Accept]
[Reject]
[Accept All]
```

Reuse upstream behavior when available.

## 23. Sessions

Support:

- new session;
- resume session;
- rename session;
- delete local session;
- active model/provider indicator;
- relevant UI state persistence.

Provider secrets must never be stored in session history.

## 24. Model/profile selection

Sidebar example:

```text
Hermes

Profile: Rangel Qwen ▼
Model: Qwen3.8-27B
```

Users must be able to switch profiles without editing JSON manually.

## 25. Locked-down corporate environment requirements

The extension must avoid requiring:

- MSI installers;
- admin/root;
- `apt install`;
- system Python;
- system Node;
- system Git;
- system-wide environment variables;
- registry changes;
- `/usr/bin` changes.

Everything should operate from user-writable paths.

If corporate endpoint security blocks an executable, the extension must fail clearly and provide executable path/hash so the user can request approval.

The project must not attempt to bypass EDR, AppLocker, Defender or other corporate controls.

## 26. Runtime distribution strategy

### MVP

```text
Install Extension
    ↓
Open Hermes
    ↓
Runtime not found
    ↓
Download compatible runtime
    ↓
Validate checksum
    ↓
Extract
    ↓
Start Hermes
```

### Fallback

```text
Runtime download blocked
    ↓
[Select Portable Runtime]
```

## 27. Settings namespace

Suggested namespace:

```text
hermesRangelTech.*
```

Examples:

```json
{
  "hermesRangelTech.runtime.mode": "automatic",
  "hermesRangelTech.runtime.updateChannel": "stable",
  "hermesRangelTech.skills.syncOnStartup": true,
  "hermesRangelTech.skills.syncBeforeLaunch": true,
  "hermesRangelTech.skills.branch": "main"
}
```

Secrets must not appear in `settings.json`.

## 28. Suggested internal modules

```text
src/
├── extension.ts
├── runtime/
│   ├── RuntimeManager.ts
│   ├── RuntimeResolver.ts
│   ├── RuntimeDownloader.ts
│   ├── RuntimeValidator.ts
│   └── RuntimeProcess.ts
├── acp/
│   ├── AcpClient.ts
│   ├── AcpTransport.ts
│   └── AcpSession.ts
├── providers/
│   ├── ProviderManager.ts
│   ├── OpenAICompatibleProvider.ts
│   └── ProviderConnectionTest.ts
├── skills/
│   ├── SkillsManager.ts
│   ├── SkillsSyncService.ts
│   ├── GithubClient.ts
│   └── ConflictResolver.ts
├── secrets/
│   └── SecretManager.ts
├── sessions/
│   ├── SessionManager.ts
│   └── SessionStore.ts
└── ui/
    ├── ChatPanel.ts
    ├── SetupWizard.ts
    ├── SettingsPanel.ts
    ├── RuntimePanel.ts
    └── SkillsPanel.ts
```

## 29. Storage layout

### Windows

```text
%LOCALAPPDATA%\HermesByRangelTech\
├── runtime\
├── skills\
├── cache\
├── logs\
└── state\
```

### Linux

```text
~/.local/share/hermes-by-rangel-tech/
├── runtime/
├── skills/
├── cache/
├── logs/
└── state/
```

## 30. Logs

Provide a VS Code output channel named:

```text
Hermes by Rangel Tech
```

Log:

- extension lifecycle;
- runtime discovery;
- runtime download;
- checksum validation;
- Hermes startup;
- ACP connection;
- provider connection errors;
- skills sync events.

Never log:

- API keys;
- GitHub tokens;
- authorization headers;
- sensitive prompt contents by default.

Prompt logging must require explicit opt-in.

## 31. Error handling

### Runtime unavailable

```text
Hermes runtime is not available for this platform.

[Select Portable Runtime]
[View Logs]
```

### Download blocked

```text
The Hermes runtime could not be downloaded.

Your network or organization may block this request.

[Retry]
[Select Portable Runtime]
```

### API authentication failure

```text
Provider returned HTTP 401.

Check the API key configured for "Rangel Qwen".

[Open Provider Settings]
```

### Skills sync failure

```text
Skills repository could not be synchronized.

GitHub returned HTTP 403.

[Check Token]
[Retry]
```

## 32. Security requirements

Mandatory:

- SecretStorage for credentials;
- HTTPS for remote APIs by default;
- checksum verification for runtime;
- no arbitrary command download-and-execute flow;
- no secrets in logs;
- no token embedded in repository URL;
- clear confirmation for destructive operations;
- dependency audit in CI.

Recommended:

- runtime signatures;
- dependency lockfiles;
- SBOM;
- automated vulnerability scanning;
- Dependabot;
- CodeQL;
- release provenance.

## 33. Privacy

Document clearly that:

- prompts may be sent to the configured provider;
- file contents may be sent when Hermes requires them;
- skills repository access only occurs when configured;
- Rangel Tech does not need to proxy LLM traffic.

Preferred architecture:

```text
User machine → User configured API
```

Not:

```text
User machine → Rangel Tech server → API
```

Rangel Tech infrastructure should only be needed for extension distribution, runtime releases/manifest and optional update metadata.

## 34. Distribution

Primary target:

**Visual Studio Marketplace**

Also publish `.vsix` artifacts through GitHub Releases.

This allows manual installation through:

```text
Extensions → Install from VSIX
```

Example artifact:

```text
hermes-by-rangel-tech-0.1.0.vsix
```

Potential runtime artifacts:

```text
hermes-runtime-win32-x64-x.y.z.zip
hermes-runtime-linux-x64-x.y.z.tar.gz
```

## 35. CI/CD

Use GitHub Actions.

Pull request pipeline:

```text
lint
↓
unit tests
↓
typecheck
↓
build
↓
package VSIX
↓
security scan
```

Release pipeline:

```text
tag v0.1.0
↓
build
↓
package
↓
GitHub Release
↓
Visual Studio Marketplace publish
```

Publishing/signing secrets must live only in GitHub Actions Secrets.

## 36. MVP scope — v0.1

Included:

- fork mature Hermes VS Code extension;
- rebrand as Hermes by Rangel Tech;
- Windows x64;
- Linux x64;
- automatic portable runtime download;
- manual portable runtime selection;
- Hermes ACP startup;
- OpenAI-compatible provider setup UI;
- SecretStorage for API key;
- provider connection test;
- existing chat UI;
- existing reasoning/tool/diff functionality;
- runtime logs;
- VSIX packaging.

Excluded from v0.1:

- GitHub push automation;
- GitHub OAuth;
- complex provider OAuth;
- macOS;
- telemetry;
- cloud session sync;
- custom backend;
- collaboration.

## 37. v0.2 scope

Add:

- GitHub skills repository configuration;
- private repository PAT;
- pull-only skills sync;
- sync on startup;
- sync before Hermes starts;
- manual sync;
- branch/path configuration;
- basic conflict detection;
- runtime updater;
- offline runtime reuse.

## 38. v0.3 scope

Add:

- multiple provider profiles;
- Anthropic;
- OpenAI;
- Gemini;
- OpenRouter;
- profile switching;
- model discovery improvements;
- bidirectional skills sync;
- optional push;
- GitHub OAuth;
- runtime channels: stable/beta.

## 39. Acceptance criteria — MVP

### Windows locked-down machine

Given:

- no admin rights;
- no Hermes installed;
- VS Code can install extension;
- user-space executable can run;

Then:

1. install VSIX;
2. open Hermes by Rangel Tech;
3. runtime downloads into user directory;
4. API profile is configured;
5. API key is stored securely;
6. Hermes ACP starts;
7. user opens local repository;
8. Hermes reads local workspace;
9. Hermes uses remote OpenAI-compatible LLM;
10. response streams in sidebar;
11. Hermes can propose/edit a local file.

No traditional software installation is required.

### Runtime download blocked

1. user copies portable runtime to machine;
2. selects runtime folder;
3. extension validates runtime;
4. Hermes starts;
5. normal usage works.

### Linux

Equivalent flow must work from a user-writable directory without root.

## 40. Acceptance criteria — Skills Sync

For v0.2, given three machines configured with the same skills repository:

1. skill added to GitHub;
2. Machine A starts VS Code;
3. extension syncs repository;
4. Hermes sees the skill;
5. Machine B starts VS Code;
6. same skill appears;
7. no manual Git command is required.

For private repositories:

- PAT stored in SecretStorage;
- no token in logs or settings.

## 41. Non-goals

The project is not intended to:

- replace Hermes;
- implement a new autonomous agent engine;
- host/proxy user LLM traffic;
- bypass corporate endpoint security;
- install kernel drivers;
- provide local GPU inference;
- replicate VS Code;
- become a proprietary fork of Hermes itself.

The goal is:

> Make Hermes easy to install, configure and use inside VS Code.

## 42. Technical principles

1. Hermes remains the agent.
2. ACP remains the primary integration layer.
3. The extension owns UX and runtime management.
4. Inference providers remain interchangeable.
5. No administrator rights should be required.
6. The runtime must be portable.
7. Skills must be portable and synchronizable.
8. Secrets must stay local via VS Code facilities.
9. The extension should work without a Rangel Tech backend.
10. The codebase should remain easy to audit, fork and contribute to.

## 43. Initial development plan

### Phase 1 — Research/Fork

- identify final upstream extension;
- verify license;
- fork repository;
- run extension locally;
- understand ACP process lifecycle;
- document architecture;
- rebrand;
- remove assumptions that require globally installed Hermes.

### Phase 2 — Runtime abstraction

Create:

```text
RuntimeManager
RuntimeResolver
RuntimeProcess
```

Initially support an existing binary, then portable mode.

### Phase 3 — Automatic runtime

Add:

- platform detection;
- runtime manifest;
- download;
- checksum verification;
- extraction;
- version storage.

### Phase 4 — Provider wizard

Add OpenAI-compatible configuration:

```text
Base URL
API Key
Model
```

Validate against a real remote Qwen endpoint.

### Phase 5 — Corporate machine validation

Test on:

- Windows corporate machine #1;
- Windows corporate machine #2;
- Linux corporate machine.

Document EDR/policy incompatibilities.

### Phase 6 — Skills

Implement GitHub repository pull synchronization.

### Phase 7 — Beta release

Generate:

```text
0.1.0-beta
```

Distribute as VSIX first. After validation, publish to Marketplace.

## 44. Proposed repository structure

```text
hermes-by-rangel-tech/
├── .github/
│   └── workflows/
├── src/
├── media/
├── runtime-manifest/
├── docs/
│   ├── architecture.md
│   ├── runtime.md
│   ├── providers.md
│   └── skills-sync.md
├── test/
├── LICENSE
├── NOTICE
├── README.md
├── CHANGELOG.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

## 45. Definition of done for first public release

Version `1.0.0` should not ship until:

- Windows x64 stable;
- Linux x64 stable;
- automatic runtime provisioning reliable;
- portable runtime fallback reliable;
- OpenAI-compatible provider support stable;
- GitHub skills sync stable;
- secrets audited;
- upstream attribution correct;
- Marketplace package clean;
- documentation complete;
- locked-down environment tests complete;
- no dependency on globally installed Hermes;
- no dependency on locally installed Git for read-only skills sync.

## 46. Final product statement

**Hermes by Rangel Tech** is a community-focused VS Code integration layer for Hermes Agent.

Its value proposition is:

> Install the extension, connect your model, synchronize your skills and start coding — without manually installing Hermes or rebuilding your setup on every computer.

The extension makes Hermes portable across restricted Windows/Linux workstations while keeping the agent local to the workspace and allowing inference to run on any compatible remote provider.
