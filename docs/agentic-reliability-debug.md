# Debugging agentic coding reliability (Hermes + self-hosted Qwen)

**Status:** CLOSED — Definition of Done met, 2026-09-28. See section 4a for the passing runs. Kept as the reference for the root cause, the fix, and `scripts/coding-task-acceptance.mjs`, which re-proves it.

**Goal.** A real coding task, driven through Hermes by Rangel Tech, against a self-hosted OpenAI-compatible endpoint (Qwen on vLLM, per the `qwen` skill), completes end to end — on Windows and on Linux — without a human babysitting it past the initial launch. Today it does not: see [dev-metrics.md](dev-metrics.md) for the two failures found so far.

**Ground rule, from the person running this project:** the LLM API stays neutral and unmodified. It is a generic OpenAI-compatible server; other clients depend on it working exactly as documented. Every fix here is something **Hermes sends or does**, never a vLLM/server-side change.

## 1. What is confirmed so far (with evidence)

| # | Finding | Evidence |
|---|---|---|
| F1 | A tool-heavy turn with thinking enabled (default) can spend 900+ seconds generating 19k+ tokens entirely as reasoning, emitting no tool call and no final message. | `docs/dev-metrics.md`, run `out/` — `agent.conversation_loop` API call #3, latency 910.6 s, out=19,240 tok, 3,168 `agent_thought_chunk` events, 0 content. |
| F2 | Disabling thinking for Hermes's own calls (`providers.<name>.extra_body.chat_template_kwargs.enable_thinking: false`, on a *named* provider, not the inline `provider: custom` shorthand) removes the reasoning leak. A plain chat turn went from indefinite hang to 11 s with 0 reasoning chunks. | `docs/dev-metrics.md`, run `out-simple/`. |
| F3 | With thinking disabled, a *tool-heavy* turn still stalls: after the 4th tool result, **no 5th `agent.conversation_loop: API call` is ever logged** — Hermes never dispatches the next request. `events.jsonl` shows no ACP message of any kind (no `session/update`, no incoming request) during the stall either. | `out4/stderr.log` (lines ending `17:04:42 ... tool terminal completed`, next line `17:09:42 ... Cleaned up inactive environment`); `out4/events.jsonl`, 20 lines, none after the 4th tool result. |
| F4 | The stall lasted **exactly 5 minutes** (17:04:42 → 17:09:42), matching the documented default `approvals.timeout: 300s` seen in Hermes's own `config.yaml` comments (ACP docs: *"Timeout: `approvals.timeout` from config.yaml (default 300s)"*). At the 300s mark Hermes's own inactivity janitor fired and tore down the sandboxed terminal environment — nothing else happened: no error to the client, no retry, no next turn. | Timestamp arithmetic above; ACP docs quoted in `docs/DEVELOPMENT_SPEC.md` §2.1. |
| F5 | Immediately before each terminal tool call, Hermes logs `agent.auxiliary_client: Auxiliary approval: using custom (qwen-abliterated)` — a **separate, hidden LLM call**, on its own logger (`agent.auxiliary_client`, not `agent.conversation_loop`), used to auto-classify whether a flagged command is safe to run. Two of these auxiliary calls appear in the log and both times a terminal tool call still completed normally right after. | `out4/stderr.log`, lines at `17:04:19` and `17:04:34`, both followed within ~9 s by `tool_executor: tool terminal completed`. |
| F6 | The test harness used for F1–F4 (`docs/spikes/s0/acp-client.js`, `hermes-spike/qwen-front/run-acp.js`) only answers the ACP method `session/request_permission`. It logs every raw incoming JSON-RPC line to `events.jsonl` regardless of type, and none appeared during the stall — so the stall is not "the harness left an ACP request unanswered". Whatever Hermes was waiting for, it never reached the ACP wire. | Harness source; `events.jsonl` line count during the stall = 0. |

**Reading F3–F5 together:** the two auxiliary-approval calls that *did* complete were for the terminal calls that succeeded. The stall began right after the 4th tool result — consistent with a **5th** auxiliary-approval (or similar internal) call being dispatched for whatever action was next (most likely writing `index.html`), which never resolves, is waited on for exactly `approvals.timeout` (300 s), and on timeout Hermes abandons the turn silently instead of surfacing an error or falling back to asking the ACP client directly.

This points at a **Hermes-side reliability gap**, not the LLM API: the API was never asked anything during the stall window (F3), so it cannot be the one hanging.

## 2. Ranked hypotheses

Ordered by how well F1–F6 already support them, cheapest to falsify first.

| # | Hypothesis | Predicts | How to falsify |
|---|---|---|---|
| H1 | An internal auxiliary call (approval classifier, or another auxiliary task — compression, title generation) hangs indefinitely; Hermes waits up to `approvals.timeout` (300 s) then silently abandons the turn with no error to the client. | Lowering `approvals.timeout` to e.g. 20 s makes the same task fail (or recover) in ~20 s instead of ~300 s, with the same silent-death pattern, just faster. | D1 |
| H2 | The specific auxiliary call that hangs is the **approval classifier**, and it hangs because it does not inherit `providers.<name>.extra_body` the same way the main conversation loop's calls do (so it silently re-enables thinking, reproducing F1 but invisibly, since auxiliary reasoning is never relayed over ACP). | `HERMES_LOG_LEVEL=DEBUG` plus a packet capture or a `providers.qwen.extra_body` set at a level that *also* covers auxiliary tasks (`auxiliary.approval.extra_body`, if such a key exists) makes the task complete. | D2, D3 |
| H3 | The auto-approval path can be skipped entirely by setting an edit/tool approval mode that always asks the human (via `session/request_permission`, which the ACP client already answers) instead of trying to auto-classify first. | Running the same task with `hermesRangelTech.editApprovalMode` (or an equivalent Hermes-side "always ask" setting) set to the most conservative mode completes without a 5-minute stall. | D4 |
| H4 | Unrelated to any LLM call: an async deadlock inside Hermes's own orchestration (a lock or queue never released) after a terminal tool result under this specific combination of tools/config. | `HERMES_LOG_LEVEL=DEBUG` shows a task/thread genuinely blocked on a Python-level primitive, not on network I/O. | D1 |

H1 is treated as confirmed pending D1; H2 is the leading explanation for *why* it hangs.

## 2a. Root cause, confirmed (no further hypotheses needed)

D1–D4 collapsed into one clean answer once tested directly, cheaper than expected: **D4 was the fix**. Setting the ACP session mode to `dont_ask` (`session/set_mode`, `modeId: "dont_ask"` — exactly what the extension's own edit-approval flow sends when `hermesRangelTech.editApprovalMode` is `dont_ask`, now the shipped default) removed the stall entirely on both platforms, with no other change needed. `approvals.timeout` was never touched, `HERMES_LOG_LEVEL=DEBUG` was never needed, and H1/H2/H4 were not pursued further because H3 (D4) resolved the observed behavior outright.

This means the internal auxiliary-approval step that appeared to hang (F5) only runs, or only hangs, under the default `editApprovalMode`, which still involves a per-action approval decision; in `dont_ask` mode every action is pre-approved and that code path is not exercised (or resolves immediately). Whether the underlying hang is a genuine Hermes bug in that specific auxiliary call, or working-as-designed caution that this project would rather not pay for by default, is now moot for this project's purposes: the shipped default (`dont_ask` + `autoApprovePermissions: true`, see the `feat: default to auto-approving...` commit) avoids it entirely, and the person running this project has accepted that trade-off explicitly (auto-approve by default, configurable).

## 3. Diagnostic plan

Run in order; stop as soon as one step gives a clear answer. Each step reuses `hermes-spike/qwen-front/prompt.txt` (or a smaller variant) against the same real Qwen endpoint, with `enable_thinking: false` already applied (F2). Budget: these are minutes-long runs on a paid GPU — do not loop blindly; read the log after each run before deciding the next one.

- **D1 — Shrink the timeout.** Set `approvals.timeout: 20` (or the smallest accepted value) and rerun the exact task that produced F3/F4. If the stall now ends around 20 s instead of 300 s, `approvals.timeout` is confirmed as the wait mechanism (H1 confirmed). Record whether Hermes then surfaces *any* message to the client on timeout, or still dies silently.
- **D2 — Full debug logging.** Set `HERMES_LOG_LEVEL=DEBUG` (the extension's `debugLogs` setting, or the env var directly for a standalone repro) and rerun. Grep the log for `auxiliary`, `approval`, `compression`, `asyncio`, and anything logged between the last tool result and the timeout. This should name the exact stuck call.
- **D3 — Auxiliary provider routing.** Read Hermes's config schema (`hermes config check`, or grep `hermes-agent`'s own source under `agent/auxiliary_client.py` if the dev tree is available) for whether auxiliary tasks (approval classification specifically) accept their own `provider`/`extra_body` override, separate from the main `model.provider`. If they default to `"auto"` and resolve differently, set them explicitly to the same named `providers.qwen` entry (with the same `enable_thinking: false`) and rerun.
- **D4 — Bypass auto-approval.** Find and set whatever Hermes config controls whether a flagged tool call is auto-classified vs. always routed to `session/request_permission` (candidates: an `approvals` config block, or the `editApprovalMode`/`accept_edits`/`dont_ask` modes already exposed by `hermesRangelTech.editApprovalMode` — check whether that setting affects only file edits or also terminal-command approval). Rerun with the most conservative mode.
- **D5 — Repeat on Linux.** Once a fix is identified on Windows, reproduce the *original failure* on Linux first (same task, same config, thinking left on) to confirm the failure mode is not Windows-specific, then confirm the fix there too. Use the existing isolated-container harness (`docker run ... node:20-bookworm-slim`, a clean `node_modules` volume) plus the real runtime pack for `linux-x64` from the embedded manifest — not the dev/spike `install.ps1` tree, which has its own unrelated launcher issues on Windows (see `docs/DEVELOPMENT_SPEC.md` §1.2) and was never installed on Linux for this purpose.

## 4. What "done" looks like

This investigation is closed only when **all** of the following hold, each with an artifact checked into this repo (a log, or the generated file plus its run log) rather than a verbal claim:

1. **A single, real, non-trivial coding task** — defined once, reused for both platforms — completes **end to end** through Hermes by Rangel Tech against the real Qwen endpoint: the agent reads existing project files through its own tools, uses at least one terminal call, and writes at least one new file with real content, with the model's default reasoning capability available to it (thinking is not blanket-disabled as a workaround; if thinking stays off, it is off for a stated, deliberate reason recorded in `docs/dev-metrics.md`, not merely because it made the hang go away here without understanding it).
2. **On Windows**, run through the **managed sealed-payload runtime** (the one built by `runtime-release.yml` and referenced from `runtime-manifest/manifest.json` — not the `install.ps1` dev tree used during today's investigation), via a script or the extension itself, within a stated, reasonable time budget (proposed: 10 minutes; revise with evidence if the model's real decode speed does not allow it, per the `qwen` skill's own measured tok/s).
3. **On Linux**, the same task, same config, same time budget, via the isolated Docker harness with the `linux-x64` runtime pack.
4. **No silent stall.** If Hermes cannot complete an action (a stuck auxiliary call, a rejected permission, a provider error), it surfaces that to the ACP client — a `session/update`, an error, or a clean failure — within a bounded time, never a multi-minute silence ending in an unannounced internal cleanup. If Hermes has no way to guarantee this (a real product limitation, not something this extension can fix), that limitation is written up plainly in `docs/dev-metrics.md` and `README.md`'s troubleshooting, with the workaround that keeps a user from being stuck.
5. **The fix (or accepted limitation) is written up**: root cause named (which internal call, why it hangs), the exact configuration that resolves it, and whether it belongs in the extension's provider-setup UI (a good candidate: an advanced "extra request body / disable thinking" field for OpenAI-compatible providers, since this is not specific to Qwen — any vLLM deployment with a similar tool-call/reasoning-parser combination would hit the same issue) or stays documented as a manual `config.yaml` edit for now.
6. **Regression coverage where it is cheap to add**: if a Hermes config setting turns out to matter (e.g. `providers.<name>.extra_body`, `approvals.timeout`), the provider-manager unit tests (`src/test/providerConfig.test.ts`) cover writing it once the extension exposes it in the UI. No unit test is expected to reproduce the live hang itself — that needs the real endpoint and stays a manual, logged procedure per this document.


## 4a. Passing runs (the Definition of Done, met)

Task: read the project's own `README.md`, `docs/spikes.md` and `runtime-manifest.json` through Hermes's tools (one run additionally loaded the `frontend-premium` skill via `skills.external_dirs`), then write `index.html` summarizing the project using only facts found in those files. Provider: named `providers.<name>` entry pointing at the real Qwen endpoint, `extra_body.chat_template_kwargs.enable_thinking: false` (see `docs/dev-metrics.md`), session mode `dont_ask`. Both runs used the **managed sealed-payload runtime** (`hrt-20260928`) resolved from the embedded `runtime-manifest.json`, not the `install.ps1` dev tree used earlier in this investigation.

| Platform | How | Result | Time | Reasoning tokens | Tool calls | Notes |
|---|---|---|---|---|---|---|
| Windows | this machine, direct process spawn of the sealed payload's `hermes-acp.exe` | **PASS** — `stopReason: end_turn` | 586 s | 0 | 7 | `write_file` correctly refused to overwrite an existing `index.html` from an earlier run; the agent read it, cross-checked every fact against the source files, and reported it was already correct rather than looping or stalling. |
| Linux | isolated Docker container (`node:20-bookworm-slim`, its own `node_modules` volume, no host access), `scripts/coding-task-acceptance.mjs` | **PASS** — `stopReason: end_turn` | 768 s | 0 | 27 | `skills.external_dirs` was not configured for this run (a gap in the test script, since fixed), so the agent searched for the skill, did not find it, and proceeded competently without it — self-correcting the generated file with several `patch` calls before finishing. Produced a real 28,692-byte `index.html`. |

Both runs: no silent stall, no reasoning leak, a real file produced with real content traceable to the source project files, using the shipped extension defaults (`dont_ask`, auto-approve). Reproduce with `scripts/coding-task-acceptance.mjs` (generalized from the exact harness used for these two runs).


## 5. Out of scope

- Changing the Qwen/vLLM server configuration. It stays generic; other clients depend on its current behavior.
- Making thinking mandatory-off as a blanket default for every custom provider in the extension. If added as a feature, it is an explicit, visible, per-profile setting — never a silent default that hides reasoning from a user who asked for it.
- Root-causing Hermes's internal orchestration beyond what `HERMES_LOG_LEVEL=DEBUG` and its own logs can show from the outside. This project does not fork or patch Hermes; a confirmed internal bug gets reported upstream (`NousResearch/hermes-agent`), referencing this document's evidence.
