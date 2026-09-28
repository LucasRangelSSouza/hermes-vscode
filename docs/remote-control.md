# Remote control (RIA Atendimento "Hermes agente")

**Status:** IN PROGRESS. Extension side (pairing, session publishing, remote command execution) is built and unit-tested. Backend domain (Fase A of `SPEC_HERMES_INTEGRADO_RIA_ATENDIMENTO.md`) is built and tested against a real Postgres. The RIA frontend "Hermes agente" view and the live end-to-end acceptance test (real login, real chat, real remote command generating a styled signup page via the self-hosted Qwen endpoint) are what remain.

## What this is

A VS Code user signs in once with their RIA Atendimento (agent-platform) credentials (`hermesRangelTech.remoteLogin`). That call pairs *this computer* as a device (`POST /api/hermes/devices/pair`) and stores a device credential (bearer token, in VS Code Secret Storage — never the password). From then on, whenever Hermes ACP connects, the extension:

1. publishes the local Hermes session to the backend (`POST /api/hermes/sessions`, upsert by `(device_id, external_session_id)`), with the computer's name attached to the device record so it shows up correctly in the RIA's "Hermes agente" UI;
2. mirrors local session activity (`agent_message_chunk`, `tool_call`, `error`, `done`) as session events;
3. polls for commands someone issued from the RIA UI (`GET /api/hermes/commands/pending`) and injects them into the local chat exactly like a message typed by hand (`ChatPanelProvider.requestRemotePrompt`), reporting back through the command's state machine (`accepted → running → completed|failed`).

## Transport: HTTP short-poll now, WebSocket Relay later

§8.1 of the spec describes a real-time "Hermes Relay" (WebSocket). We did not build that yet. Instead, `RemoteSessionPublisher` (`src/remoteControl.ts`) polls `GET /api/hermes/commands/pending` every 4 seconds and calls the same REST endpoints a Relay-based client would call for session/event/command state.

This is a deliberate, reversible substitution, not a silent scope cut:

- The domain contract (devices, sessions, events, commands, approvals, idempotency, RBAC, tenant isolation — Fase A) is exactly what the Relay would sit in front of. Nothing about that contract changes when the Relay is built.
- Swapping the transport later means replacing the `setInterval` poll loop in `RemoteSessionPublisher` with a WebSocket subscription that calls the *same* `upsert`/`publish`/`transition` methods it already has. No backend or protocol change is required first.
- Cost of the shortcut: up to ~4s latency between a command being issued in the RIA UI and the extension picking it up, and one HTTP round-trip every 4s per paired, attached device even when idle. Both are acceptable for a human operating a chat, not for anything latency-sensitive.

Build the Relay when either: (a) poll traffic becomes a real cost/load concern, or (b) a use case needs sub-second command delivery.

## Key pieces

| File | Responsibility |
|---|---|
| `src/remoteControl.ts` | `pairDevice`/`pairedDevice`/`unpairDevice` (pairing lifecycle); `RemoteSessionPublisher` (session upsert, event publishing, command polling/execution) |
| `src/sessionManager.ts` | `onUpdate` now broadcasts to multiple handlers (`ChatPanelProvider` AND `RemoteSessionPublisher` both observe the same session independently) |
| `src/chatPanel.ts` | `requestRemotePrompt(text)` — injects a remote instruction through the exact same `handleFromWebview({type:'send', text})` pipeline a locally typed message uses, so it queues/runs the same way and shows up in the local chat too |
| `src/extension.ts` | wires `RemoteSessionPublisher` into the ACP connection lifecycle (`attachRemoteIfPaired`, called from `ensureAcpClientStarted`'s `onConnected`); registers `hermesRangelTech.remoteLogin`/`remoteLogout` commands |
| `package.json` | `hermesRangelTech.remote.baseUrl` (backend URL; empty disables remote control entirely), `hermesRangelTech.remote.deviceName` (override for the computer name shown in the RIA UI; defaults to `os.hostname()`) |

## `externalSessionId`

One Hermes session per VS Code workspace is published remotely. Its `externalSessionId` is a random id generated once and persisted in `context.workspaceState` (`hermesRangelTech.externalSessionId`), so re-opening the same workspace continues updating the same remote session row (`hermes_sessions_device_external_key UNIQUE (device_id, external_session_id)`) instead of creating a new one every time the extension activates.

## Completion signal: why not just await `sendLocalPrompt`

`ChatPanelProvider.requestRemotePrompt` calls into the same queue/dispatch path as a typed message. If the panel is busy, that call resolves as soon as the message is **queued**, not when the Hermes turn actually **finishes**. `RemoteSessionPublisher.waitForNextTurnDone()` instead races the real `done` event that already flows through `onLocalUpdate` (the same broadcast `SessionManager.onUpdate` stream `ChatPanelProvider` consumes), with a 15-minute safety timeout. Only when that resolves does the command transition to `completed`.

## Testing

- `src/test/remoteControl.test.ts` — unit tests (VS Code module stubbed, `fetch` faked): pairing success/failure, `pairedDevice` requiring both a device record and a credential, `unpairDevice` best-effort revoke, a full remote-command run (`pollOnce` → `accepted` → `running` → local prompt → `done` → `completed`), and rejection of a command with no instruction text.
- Backend Fase A tests (`agent-platform/backend/tests/test_hermes_*.py`) cover the domain this module talks to: pairing/session/command/approval/audit APIs, RBAC, idempotency, tenant isolation.
- Not yet done: a live end-to-end run against a real running backend + real VS Code extension + the self-hosted Qwen endpoint, generating a styled HTML/CSS signup page from a remote command (the spec's acceptance test).
