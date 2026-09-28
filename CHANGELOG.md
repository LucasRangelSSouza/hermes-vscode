# Changelog

## 0.1.0 - unreleased

First release of Hermes by Rangel Tech, derived from `hermes-vscode` 3.6.0.

### Added
- Managed Hermes runtime: downloaded from GitHub Releases as SHA-256 verified packs, extracted into a user folder, validated with `--version` and `--check`, with resume, a cross-window install lock and safe extraction.
- Portable runtime mode for networks that block the download, and existing-Hermes mode.
- Provider wizard for OpenAI-compatible endpoints with a four-step connection test (reach, auth, model, inference) and classified errors.
- API keys in VS Code Secret Storage, passed to Hermes only through the process environment. Log redaction for keys and tokens.
- Private Hermes home so the extension never touches an existing `~/.hermes`.
- Commands: Setup, Configure Provider, Test Provider Connection, Configure Skills Sync, Sync Skills Now, Install or Repair Runtime, Select Portable Runtime Folder, Show Runtime Status, Show Logs.
- Skills sync (pull only): a GitHub repository folder is mirrored through the REST API, without Git, and Hermes reads it as an external skills directory. Sync on startup and before launch, private repositories through a Secret Storage token, a trust prompt on first use, and no silent overwrite of hand edits.
- Windows x64 and Linux x64 runtimes built by CI on native runners.

### Changed
- Renamed the extension, commands, views and settings to `hermesRangelTech.*`. Session storage uses a new key.
- Process trees are ended on Windows so tool processes do not outlive the agent.
- Profile listing and version detection work on Windows (path separator, no `which`).

### Removed
- Upstream Marketplace publishing workflows, governance documents and the original-extension coexistence guard.

---

Changes below this line are from the upstream `hermes-vscode` history.

# Change Log

## A note on versioning

The `v1.x` and `v2.x` lines used milestone-oriented versioning. From `v3.0.0` onward, releases follow semantic versioning.

---

## [Unreleased]

## [3.6.0] — 2026-08-11

### Added

- Show active `delegate_task` workers as session-bound `Delegate · …` activity chips, and remove them when their delegation finishes or the owning ACP runtime generation ends.

### Fixed

- Persist semantic titles received from Hermes ACP into the matching saved session instead of leaving the opening-message fallback in the session list.
- Prefer bounded Hermes ACP delegation metadata so large multi-task dispatches remain observable even when human-readable tool output is truncated, while retaining strict legacy parsing for older agents.
- Preserve a successful, session-owned delegation registration when its initiating foreground prompt is cancelled after background dispatch.
- Accept both current and producer-supported legacy delegation cache layouts with the same fail-closed path and symlink controls, and align the observable manifest envelope and Unicode character counting with Hermes Agent's explicit 100-worker, 500-character-goal safety ceiling.

### Maintenance

- Adopted the controlled, globally unique Marketplace identity `stefanpieter.hermes-ai-agent-maintained` with explicit migration warnings and a fail-closed original-extension coexistence guard, and added exact-tag, release-triggered, duplicate-safe Marketplace publication automation.
- Established `stefanpieter/hermes-vscode` as the canonical maintained successor repository while preserving original MIT attribution and keeping Marketplace publisher authority as a separate release gate.
- Added cross-platform CI for type checking, secret scanning, regression tests, production builds, dependency security auditing, and deterministic VSIX package inspection without publicly uploading an unauthorised publisher artefact.
- Made background-test discovery independent of shell glob expansion so the suite runs consistently on Linux, macOS, and Windows CI; branch pushes now run separately only for `main` to avoid duplicate pull-request jobs.
- Added a single `npm run verify` release gate and removed generated profile test output after successful runs.
- Updated DOMPurify and the VSIX packaging toolchain to eliminate known dependency advisories from the locked build.
- Added an isolated lockfile audit that forces an online query to the official npm registry, ignores external npm offline/omit/production/registry settings, verifies npm's reported dependency population against `package-lock.json`, validates vulnerability-metadata structure and consistency, and fails on advisories at every severity across production, development, optional, and peer dependencies; behavioural tests cover hostile configuration and fail-closed process, output, and cleanup handling.
- Removed private machine assumptions and stale Hermes Agent links from contributor documentation.

### Security

- Disable the extension in VS Code Restricted Mode because Hermes launches an autonomous local agent with access to the current workspace.
- Validate pasted-image extensions against a fixed allowlist in the extension host before constructing media-cache paths.

## [3.5.1] — 2026-07-28

### Fixed

- Live standalone roles running in linked Git worktrees now appear in the repository's Lead window, while stale, dead-PID, and unrelated-repository manifests continue to fail closed.
- Sending a message through an already healthy ACP child no longer inserts redundant “Connecting to Hermes… Connected” messages into the transcript; real starts and reconnects remain visible.
- Lead context now follows ACP's current-window usage feed instead of briefly substituting cumulative turn billing, and compression counts remain visible when Hermes publishes them.

## [3.5.0] — 2026-07-27

### Added

- Each live agent chip can now show that agent's own current context usage and compression count (for example `799k/1M · 3 comp`) when Hermes publishes authoritative telemetry.
- The primary ACP agent is labelled `Lead / PM`, making clear that its context counter excludes standalone role conversations.

### Fixed

- The activity bar now requires both a live child PID and a fresh runner heartbeat, and no longer presents completed or stale role-run manifests as running agents.
- Restored Lead sessions retain genuinely live same-workspace roles instead of hiding them because they started before the restored session.
- Metadata-only compression updates now survive ACP partial updates, and adapter metadata can refine primary status/metrics without renaming the primary **Lead / PM** identity.

## [3.4.4] — 2026-07-27

### Fixed

- Concurrent connection requests now share and await one ACP initialization handshake, so no caller can issue session RPCs against a child that has spawned but is not ready.
- A rejected ACP initialization handshake now stops the unusable child, rejects every waiting caller, and permits a clean subsequent connection attempt.

## [3.4.3] — 2026-07-27

### Fixed

- Composer sends now verify and, when necessary, restart the ACP client inside the prompt's cancellation boundary, preventing a long-lived window from failing with `ACP client not started` after its child process exits.
- Replacement ACP children now explicitly reload the persisted session before prompting, and Stop during reconnect prevents that delayed prompt from starting.

## [3.4.2] — 2026-07-27

### Fixed

- Queued-message Delete now uses VS Code's supported Extension Host confirmation UI instead of a browser `confirm()` call that sandboxed webviews can suppress; cancelling retains the row, while confirming deletes only the matching stable request ID and republishes authoritative queue state.

## [3.4.1] — 2026-07-26

### Changed

- The composer now keeps pulsing while an authoritative standalone role is `starting` or `running`, so a Lead waiting for delegated work does not appear to have stopped; this visual signal does not mark the ACP turn busy or disable input.

## [3.4.0] — 2026-07-25

### Added

- Added an agent-activity strip showing the primary Hermes lifecycle and exact context usage, plus repository-scoped standalone role names and statuses from authoritative Hermes role-run manifests.
- Added optional per-role context display when the role runtime supplies explicit `context_used` and `context_size` values; unavailable metrics remain visibly unknown rather than estimated.

### Changed

- The slash-command menu and command classification now consume Hermes ACP `available_commands_update` metadata, so additions, edits, and removals propagate without maintaining a second UI list.
- Corrected the compatibility command catalog from obsolete `/compact` to Hermes `/compress`.
- Active ACP sessions now hydrate on panel readiness so command metadata is current without waiting for the first prompt; replay metadata is accepted without duplicating the locally restored transcript.

## [3.3.0] — 2026-07-24

### Added

- Queued composer messages now appear above the toolbar with inline Edit and Delete controls while another turn is active.
- Queue controls use stable request IDs and host-authoritative hydration, so duplicate text and recreated webviews cannot mutate the wrong pending message.

### Changed

- Editing a queued prose message preserves the files, skills, and IDE context captured at submission; changing it into a known slash command safely discards context that slash commands do not accept.

## [3.2.13] — 2026-07-23

### Fixed

- Reopening or recreating the chat webview now restores the active session's persistent background-work indicator, so a running supervised Lead/worker remains visibly pulsing after the panel's ready handshake.

## [3.2.12] — 2026-07-22

### Fixed

- Explicit Stop now owns the active turn before first-session creation or stored-session loading begins, so cancellation during ACP session binding cannot be cleared before `session/prompt` starts.
- Session persistence now runs inside the cancellation-owned prompt operation, preserving ACP ownership without opening a pre-prompt cancellation gap.
- Per-turn cancellation state and the terminal-response barrier keep queued prompts serialized and stale cancelled updates gated.

## [3.2.11] — 2026-07-22

### Fixed

- Reopening or recreating the chat webview during an active turn now restores the host-owned busy state, queue count, and slash-response semantics through an explicit ready handshake.
- Composer submissions use UUID-backed identities across webview lifetimes, preventing queued prompts retained by the host from colliding with messages sent from a recreated view.

## [3.2.10] — 2026-07-22

### Fixed

- Stop now keeps the active turn behind an ACP terminal-response barrier, preventing a queued follow-up from overlapping the remotely cancelling prompt.
- Queue handoffs use stable composer request IDs, so a host-only command cannot consume an identical composer-queued command; the first send also claims busy state synchronously so rapid follow-ups cannot outrun queue bookkeeping.
- Slash-command documentation now matches the commands handled by the current Hermes ACP adapter.

## [3.2.9] — 2026-07-22

### Fixed

- Messages submitted while Hermes is working now wait in one local FIFO queue instead of hard-cancelling the active ACP request. Model changes and slash/menu actions use the same serialized path; session renames remain local and do not start an ACP prompt. This prevents the working pulse from stopping while follow-ups silently produce no response; the Stop button remains the explicit hard-cancel control.
- Queued turns retain their own attachments, selected skills, IDE context, and slash-command display semantics instead of borrowing mutable composer state from later messages.

## [3.2.8] — 2026-07-15

### Added

- `Hermes: Select Edit Approval Mode` exposes Hermes ACP's Default, Accept Edits, and Don't Ask modes. The selected machine-scoped mode is applied to active sessions and reapplied after session creation or resume.

### Fixed

- Autonomous continuations can use the workspace-scoped Accept Edits mode instead of silently waiting 60 seconds for an unattended one-shot prompt and then reporting an ACP edit-approval denial. The secure Default mode remains the default, workspace settings cannot weaken it, and sensitive paths still require approval.

## [3.2.7] — 2026-07-14

### Fixed

- ACP permission approvals now return the protocol-required nested outcome object, so approved file edits are no longer interpreted as denials by Hermes with `agent-client-protocol` 0.9.0.
- ACP restarts now isolate child-process generations, so a stopped process's delayed exit or permission reply cannot detach, reject, or write into its replacement.
- Command Palette profile changes now restart a running ACP client immediately, keeping the displayed profile aligned with the process that is actually running.
- Switching sessions now restores the target session's background-process indicator after clearing the previous view.

## [3.2.5] — 2026-07-12

### Added

- Permanent `Hermes: Restart Agent` Command Palette action for safely restarting the ACP subprocess without changing profiles.

## [3.2.4] — 2026-07-12

### Added

- Persistent per-session background-work indicator driven by terminal/process lifecycle results and structured Hermes ACP completion metadata.

## [3.2.3] — 2026-07-11

### Fixed

- Background process completions delivered by Hermes after a prompt ends now appear immediately as standalone messages and persist in session history.
- Background updates are isolated to the active ACP session and no longer contaminate the next foreground response.
- Session-load history replay remains correctly routed and is not misclassified as a background notification.

## [3.0.0] — 2026-04-06

Release candidate. Ships the full v3.0.0 architecture plus a major slash-command surface expansion, session-persistence and context-loading fixes, and a redesigned composer layout — all validated against live Hermes usage.

### Added

**Composer redesign (Claude Code-style)**
- Textarea and bottom toolbar now share a single rounded "composer" pill with a gold border that glows during agent turns.
- Logo moved to the center of the bottom bar.
- Send / Stop / Queue buttons moved to the right of the bottom bar (alongside the logo and left-side action buttons).
- Textarea claims the full width of the composer — no more logo-shaped dead zone on the right.
- Todo overlay now pops up as a floating card directly above the composer, anchored to it, instead of being pinned to the top of the messages pane.

**Grouped slash-command menu**
A new `/` button in the bottom toolbar opens a grouped dropdown organised into four sections:

- **Session**: `/title` (rename — inline popover), `/new` (clear history), `/retry` (remove last exchange), `/compact` (compress context), `/save` (write conversation JSON to workspace — inline popover), `/btw` (ephemeral side question using session context — inline popover)
- **Info**: `/context` (message counts + model), `/usage` (token breakdown: prompt, completion, cache, reasoning, cost), `/tools` (list available tools), `/help` (command list)
- **Configuration**: `/yolo` (toggle dangerous-command auto-approval; red composer glow when ON), `/reasoning` (show or set effort level — inline popover)
- **Danger**: `/reset` (clear conversation — confirmation dialog)

Menu items use three dispatch modes: `execute` (runs immediately), `prompt` (shows an inline argument input next to the button), and `confirm` (shows a confirmation dialog for destructive actions).

**Slash-command message styling**
Slash command inputs and their responses no longer render as normal conversation bubbles. Recognised commands from a hardcoded allowlist mirroring the ACP adapter's dispatch table render as centered "system" messages — muted background, no `YOU`/`Hermes` avatars — reflecting that they're controls, not conversation. Unrecognised `/foo` inputs still go to the LLM and render as normal messages.

**YOLO mode with live visual feedback**
`/yolo` toggles the `HERMES_YOLO_MODE` env var inside the ACP adapter subprocess, bypassing dangerous-command approvals (mirrors the CLI). Supports explicit `/yolo on` / `/yolo off` args. The extension parses the adapter's response text to drive a persistent red composer glow while YOLO is active — ground-truth driven, not optimistic client state.

**`/title` round-trip to state.db**
Renaming a session in the extension now persists the title to Hermes's SQLite state store. `hermes sessions list` in the terminal shows the titles. Requires the matching Hermes adapter patch (see below).

**Token display rework**
Total context usage is now the headline metric (e.g. `17.1k (17.1k cached) / 1M`), with cache reads shown in parentheses as a cost signal. Replaces the earlier "fresh tokens" display which could read `0` during fully-cached continuations and looked broken.

### Fixed
- **Session reset leak** — clicking "new session" no longer silently resumes the previous ACP session. `SessionManager.reset()` now clears both `sessionId` and `storedSessionId`, matching the semantic promise of the name. Symptom before the fix: a fresh chat would arrive with 40+ messages of phantom history and burn ~40k tokens per first turn.
- **ACP session persistence** (P0 from 2026-04-05 Hermes diagnosis) — `ensureSession()` now prefers `session/load` for stored IDs and only falls through to `session/new` when the adapter reports the session missing, fixing the earlier phantom-session bug where messages were silently lost.
- **Cron session IDs** (Hermes side) — cron jobs now reuse a stable `cron_{job_id}` session per job instead of creating a timestamped throwaway on every run. One job = one continuous conversation, not 48 sessions/day per cron.
- **`skip_context_files` for ACP** (Hermes side) — the ACP adapter no longer auto-loads `~/CLAUDE.md` / `AGENTS.md` / `HERMES.md` from the editor's CWD, which was injecting ~25k tokens of ambient home-directory docs into every session. Opt-in via `HERMES_ACP_LOAD_CONTEXT=1`.

### Changed
- **Marketplace metadata** — extension now declared in `AI`, `Chat`, `Machine Learning`, and `Other` categories. Keywords expanded for discoverability: `ai agent`, `coding assistant`, `autonomous agent`, `claude`, `codex`, `copilot alternative`, `pair programmer`, `remote ssh`, etc.
- **Activation events** simplified to `[]` — VSCode now infers activation from `views` and `commands` contributions (modern API since 1.74).

### Architecture
The v3.0.0 line decomposed two monoliths that had grown through v1 and v2:
- `chatPanel.ts` (1,316 → 509 lines) — extracted `sessionStore.ts`, `htmlTemplate.ts`, `types.ts`, `protocol.ts`
- `webview/main.ts` (853 → 435 lines) — extracted `webview/state.ts`, `webview/renderers.ts`, `webview/menus.ts`

Pre-v3, there was no typed protocol layer; parsing was scattered through `Record<string, unknown>` call sites. `src/types.ts` and `src/protocol.ts` now centralise ACP schema knowledge.

### Security — preserved from v1.0.4
All v1.0.4 security hardening carries forward: trusted-workspace gate, machine-scoped `hermes.path`, explicit binary-approval prompts, per-request permission dialogs, sandboxed media cache, HTML escaping throughout.

---

## [2.0.5] — 2026-04-02

- **Fixed**: Ambiguous Codex model names (e.g. `gpt-5.4`) were routing to OpenRouter because of a model-catalog collision. Those entries are removed from the catalog; Codex models reach Codex OAuth subscription.

## [2.0.4] — 2026-04-02

- **Fixed**: Sticky-prompt bubble now shows more lines and clicks scroll back + unpin. (Feature later removed in v3.0.0-beta — it never stopped looking "bizarre".)

## [2.0.3] — 2026-04-02

- **Added**: Experimental sticky last-prompt pinned at top while scrolling.

## [2.0.2] — 2026-04-02

- **Fixed**: Model picker now shows friendly labels from the catalog instead of raw `provider:model-id` strings.

## [2.0.1] — 2026-04-02

- **Fixed**: Model picker was trapped inside a hidden `#model-switcher` div and never dropped down. Moved to the header.

## [2.0.0] — 2026-04-02

**Council-driven UI overhaul.** A four-reviewer design council gave the v1 UI a 3/10 on UX and 3.5/10 on visual design. This release responded to that feedback.

### Redesign
- **Two-row header** — Row 1: `☤ Hermes · claude-sonnet-4-6 ▾` (brand + model picker). Row 2: session name · token counter with progress bar.
- **Empty state** — four prompt chips ("Review this file", "Explain the selected code", "Find bugs in this project", "Write tests for this module") disappear after first message.
- **Toolbar collapsed** to three buttons: `⊕` attach, `✦` skills, `···` overflow.
- **Model selector promoted** from buried toolbar button to the header.

---

## [1.0.4] — 2026-04-02

Security and stability hardening.

### Security
- Require trusted-workspace behavior before launching Hermes.
- Ignore workspace-scoped `hermes.path` overrides and constrain the setting to machine scope.
- Prompt before launching a new Hermes binary path and remember approved binaries.
- Replace blanket permission auto-approval with explicit per-request prompts.
- Restrict webview local resource access to the extension media cache instead of `~` and `/tmp`.
- Reduce default log exposure by turning diagnostic logging off by default and trimming prompt payload logging.
- Escape model menu content and remove HTML string insertion for skill/session/file-chip UI built from local metadata.

### UI
- Normalize bottom-toolbar button sizing and focus styles.
- Tighten toolbar layout for narrow sidebars.
- Keep attachment chips and dropdown labels consistent without HTML injection glitches.

---

## [1.0.0] — 2026-04-02

**First public release.** Marketing-named `v1.0.0` as "initial stable" — see the note at the top of this file for honest commentary. In practice this was closer to a `v0.6.0` or so: feature-complete enough to use daily, but still finding its shape.

### Chat & Streaming
- Sidebar chat panel with streaming markdown rendering and DOMPurify sanitization.
- Extended thinking display (gold italic status line).
- Inline image rendering via Hermes `MEDIA:/path` protocol.
- Copy buttons on all code blocks.
- Queued prompts submitted while the agent is working run after the current turn.
- Logo pulses gold and input border glows while agent is working.

### Tool Integration
- Claude Code-style tool call display with bold kind labels (Read, Edit, Bash, Search, Fetch).
- Tool status icons: `✓` green (done), `⋯` gold (running), `✗` red (error).
- Tool calls rendered in monospace code-block frames.
- Live file integration — edited files auto-open in VS Code editor; reads open as preview tabs.

### Context & Attachments
- IDE context awareness — active file, selection, and open tabs sent with each message.
- File attachment via ⊞ button, drag & drop from explorer, or clipboard paste (Ctrl+V).
- Multiple file attachments accumulate as chips, cleared after send.

### Skills
- Dynamic skills picker (✦ button) loads 100+ skills from `~/.hermes/skills/`.
- Skills grouped alphabetically with multi-select toggles.
- Selected skills injected as advisory prefix in the prompt.

### Sessions
- Persistent sessions stored in VS Code workspaceState (survive reloads).
- Session picker with rename (`✎`), delete (`✕`), switch.
- Auto-titled from first user message.
- ACP session ID persistence for context resume across restarts.

### Models
- Multi-provider model switching: Anthropic Claude + OpenAI Codex.
- Grouped model picker with `provider:model` syntax for seamless provider changes.
- Dynamic catalog from `~/.hermes/models_dev_cache.json` with hard-coded fallbacks.

### Token Tracking
- Live token counter with gold current value and progress bar.
- Color-coded warnings: gold at 70%, red at 90% context usage.
- Context window size from Hermes `_meta.contextLength`.

### Todo Overlay
- Persistent task checklist below status bar when Hermes uses its todo tool.
- Status icons: □ pending, ■ in-progress (gold), ✓ completed (green), ✗ cancelled.

### Technical
- ACP (Agent Client Protocol) over JSON-RPC 2.0 stdio subprocess.
- Runs on workspace/server side for VS Code Remote SSH.
- Auto-resolves hermes binary from `~/.local/bin`, `/usr/local/bin`.
- Streaming text deduplication (exact, prefix, suffix match).
- CSP with DOMPurify for all agent-generated content.
- `extensionKind: ["workspace"]` for remote compatibility.

---

## Pre-history (unreleased, late March → 2026-04-02)

Days of private iteration against Hermes's evolving ACP adapter. Every time Hermes added a protocol feature — session persistence, model switching, tool updates, todo tool, usage metadata — this extension integrated it. Much of what shipped as "v1.0.0" was the cumulative result of that work, which in a less hurried timeline would have been `v0.0.1` through `v0.9.x`.
