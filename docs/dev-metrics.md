# Development time and Hermes performance metrics

Measured 2026-09-28, on the machine and endpoints described in `docs/spikes.md`. Times are wall-clock for this session, not calendar time.

## Development timeline (this session)

| Phase | What | Approx. time |
|---|---|---|
| Research | Read Hermes and upstream extension source, licenses, install methods | ~1h |
| Spec | `docs/DEVELOPMENT_SPEC.md` v1 | ~40 min |
| M0 spikes (local) | S0–S5 on this machine: install, ACP round trip, `config set`, terminal tool | ~35 min, mostly one `install.ps1` run (~3 min) plus manual ACP scripting |
| M0 spikes (CI) | Sealed-payload build lane discovery, S1b workflow (4 runs to green: `scripts.bundles.stage` fails on this canary, `tar` on Windows, Node/npm pin mismatch) | ~2h of CI wall time, most of it Windows builds (~15 min each) |
| M1–M6 implementation | Runtime installer, validator, provider manager, skills sync, extension wiring, ~200 tests | ~3h |
| Runtime release pipeline | `runtime-release.yml` end to end, both platforms, packs, manifest sync | ~1h of CI wall time (2 full builds + 1 partial rebuild for the tar/order fix) |
| Real-world verification | Manual Windows e2e (found and fixed the terminal-snapshot key leak), Linux verify workflow | ~30 min |
| **Total** | | **about one working day** |

The single biggest time cost was **Windows runtime builds** (compiles native Python extras with MSVC): 15–35 minutes each, and it took 3 attempts to get the pack split and end-to-end verification right. CI wall time, not attention time — most of it ran unattended while other work continued in parallel.

## Hermes Agent performance (installation and startup)

| Metric | Value | Source |
|---|---|---|
| Official installer, cold, this machine | ~3 min (Python + deps + Node build) | S0 |
| `hermes-acp --version` | 0.4–0.6 s | S1b, e2e |
| `hermes-acp --check` (full ACP self-check) | 1.1–1.5 s | S1b |
| ACP `initialize` → `session/new` → first streamed token, against a local mock | well under 1 s | e2e |
| Sealed payload extraction (core pack, ~650 MB compressed) into a folder with spaces/non-ASCII, this machine | ~500 s (~8 min) | e2e, Windows |
| Sealed payload build (`native_build.py`), CI | 902 s (Windows) / 206 s (Linux) | S1b |
| Runtime archive size, core only | 666 MB (Windows) / 696 MB (Linux) compressed | `runtime-manifest.json` |
| Runtime archive size, all packs | 2.12 GB (Windows) / 1.99 GB (Linux) compressed | `runtime-manifest.json` |

The extraction time (~8 minutes for one pack) is the number that most affects a user's first run and is worth watching once more packs are involved; it was not previously measured.

## Hermes Agent performance (model inference, real Qwen endpoint)

Endpoint: `https://qwen.rangeltech.net/v1`, model `qwen-abliterated` (NVFP4 + speculative decoding, per the `qwen` skill: ~41 tok/s raw). Task: read 3 project files (~20 KB total) plus a skill file (~9.5 KB) through Hermes's own tools, then write an HTML page.

| Step | Latency | Notes |
|---|---|---|
| API call 1 (tool selection: skill + 3 reads) | 15.0 s | in=14,943 tok, out=139 tok |
| 4 tool calls (skill_view + 3× read_file) | ≤4 s total | local, not model-bound |
| API call 2 (plan) | 261.3 s | in=25,016 tok, out=4,377 tok |
| API call 3 | **910.6 s** (15.2 min) | in=25,827 tok, out=19,240 tok, **all of it landed as reasoning, not as a tool call or a final message** |
| Result after a 20-minute budget | No file written; 0 chars of final answer; 3,168 reasoning chunks | run cancelled by the harness timeout |

**Finding.** This matches a limitation the `qwen` skill's own notes already flag for this serving stack: *"vLLM with `--tool-call-parser qwen3_xml` + a reasoning parser can leak tool calls into plain text instead of returning `tool_calls`"*. Here the model kept "thinking" instead of emitting the next tool call, and Hermes's agent loop had no output to act on. Independently confirmed against vLLM's own issue tracker: [vllm-project/vllm#51679](https://github.com/vllm-project/vllm/issues/51679) documents the exact interaction (the `qwen3_xml` tool parser can swallow the reasoning/tool-call boundary), and Hermes's own changelog fix for [issue #72901](https://github.com/NousResearch/hermes-agent) addresses precisely this failure mode by adding a `model.streaming: false` escape hatch. This is a property of the model-serving configuration (a documented vLLM/qwen3_xml/reasoning-parser interaction on this specific endpoint), not a defect in the Hermes ACP integration: `initialize`, `session/new`, streaming, the terminal tool and permission handling all worked correctly in the same environment against a mock endpoint (see `docs/spikes.md`, S1b) and this exact model earlier in the same session (`docs/spikes/s0/acp-client.js` scripted round trip).

**Fix, verified against the real endpoint the same day, without touching the vLLM server.** The vLLM server is deliberately kept neutral/generic (it also serves other clients that need reasoning on); the fix has to be in what Hermes sends. Two independently sufficient client-side options exist, both documented in Hermes's own `config.yaml` comments:

1. **`providers.<name>.extra_body.chat_template_kwargs.enable_thinking: false`** on the named provider entry — Qwen's own documented way to disable thinking per request (`chat_template_kwargs` in the `extra_body` of the chat completion call). Requires switching from the inline `provider: custom` shorthand to a *named* provider block (`providers.qwen: {base_url, api_key, extra_body}`, `model.provider: qwen`) — the inline shorthand has no field for `extra_body`. **Verified**: a plain chat turn against the real endpoint returned in **11 s** with **0 reasoning chunks**, versus the 910.6 s / 19,240-reasoning-token hang before the fix. A second finding while wiring this up: the API key must then live at `providers.<name>.api_key`, not `model.api_key` — the two are separate fields, and the old `model.api_key` is silently ignored once `model.provider` points at a named entry.
2. **`model.streaming: false`** — keeps thinking on (Hermes's own fix for #72901: the streaming tool-call path is what breaks with this parser combination; a non-streaming call is not affected). Not used here because the goal was to keep reasoning available as a tool *and* avoid the leak; option 1 achieves both by disabling thinking only for Hermes's own tool-heavy agent turns while the server stays capable of reasoning for any other client that requests it.

The same tool-heavy coding task (read 4 project files, write an HTML page) still ran long under option 1 — no reasoning leak, 0 thought chunks, but no final answer within a 7-minute budget after 8 tool calls at roughly 9,500 tokens of accumulated context. That is expected decode-throughput behavior for this hardware and context size (see the `qwen` skill's own measurements), not a recurrence of the bug; the isolated no-tool test above proves the fix itself works.

**Consequence for the extension.** Not a bug to fix here. It does mean that with certain self-hosted OpenAI-compatible backends, a coding turn can run for many minutes without visible progress. `hermesRangelTech.editApprovalMode` and the stop button already give the user a way to cancel; nothing further is scoped for v0.1. If this recurs with other self-hosted endpoints, the `model.streaming: false` escape hatch documented in Hermes's own `config.yaml` comments is the first thing to try.

## Security finding from live verification

Running the terminal tool through the managed runtime revealed that Hermes's own terminal snapshot mechanism (`<HERMES_HOME>/cache/terminal/hermes-snap-*.sh`) writes the **entire process environment**, via `declare -x`, to disk in the clear — including the provider API key variable this extension injects. This was not caught by unit tests, only by running the real runtime with a real terminal command. Fixed the same day: `src/runtime/terminalSnapshots.ts` purges that folder before every managed launch and on deactivate. See the commit `fix(security): purge Hermes terminal shell snapshots...` and `scripts/e2e-real-runtime.mjs`, which now reproduces the leak and asserts the fix.
