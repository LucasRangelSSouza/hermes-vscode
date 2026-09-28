# Repository guidance

This repository contains Hermes by Rangel Tech, a VS Code extension that runs Hermes Agent locally over ACP (JSON-RPC 2.0 on stdio) and manages the Hermes runtime and provider settings.

Read `docs/DEVELOPMENT_SPEC.md` for the design and `docs/spikes.md` for the evidence behind it.

## Source orientation

```text
src/
  extension.ts        activation, commands, wiring of the services below
  runtimeService.ts   runtime resolution (automatic, portable, existing), install UI and error messages
  providerService.ts  provider wizard, connection test UI, applying the profile to the runtime
  runtime/            manifest, installer, validator, process helpers (no vscode imports)
  providers/          profile model, config writer, connection test (no vscode imports)
  paths/              data folder layout and the active HERMES_HOME
  secrets/            log redaction
  acpClient.ts        Hermes ACP subprocess and JSON-RPC lifecycle
  sessionManager.ts   session lifecycle and streamed ACP updates
  sessionStore.ts     workspaceState persistence
  chatPanel.ts        extension-host authority for webview/session UI state
  protocol.ts         ACP update parsing and normalisation
  webview/            sandboxed browser-side UI
runtime-manifest/     pinned runtime packs (URL, size, SHA-256) embedded in the VSIX
```

## Required gates

```bash
npm ci
npm run verify
```

For focused work run the smallest relevant test first (`node --import tsx --test src/test/<name>.test.ts`), then the full gate.

## Engineering rules

- Keep modules that do not need VS Code free of the `vscode` import so they stay unit-testable.
- The extension host is authoritative; webview state is transient.
- Bind asynchronous ACP events to the child-process generation and session that created them.
- Every path under Hermes's home goes through `paths/hermesHome.ts`. Never hard-code `~/.hermes`.
- Secrets live in SecretStorage and reach Hermes only through the child's environment. Never write one to a file, a setting or a log; register it with `secrets/redactor.ts`.
- Settings that choose what executable runs are machine-scoped and ignore workspace values.
- Runtime downloads accept only the trusted release prefix and GitHub hosts, and are verified by SHA-256 before extraction.
- Windows is a first-class target. Test path handling with spaces and non-ASCII characters.
- Never include user-specific paths, hosts, model selections or credentials in tracked files.
- Preserve the original MIT attribution in `LICENSE` and `NOTICE`.
- Use the public Hermes Agent documentation and repository as the compatibility reference. Do not import Hermes Python modules; ACP is the only contract.
