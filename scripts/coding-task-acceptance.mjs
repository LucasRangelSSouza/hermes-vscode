// Acceptance test for docs/agentic-reliability-debug.md's Definition of Done: a real coding task,
// through the managed sealed-payload runtime, against a real OpenAI-compatible endpoint, completing
// end to end with no silent stall — on whichever platform this runs (Windows x64 or Linux x64).
//
// Confirmed passing 2026-09-28 on both platforms (see docs/dev-metrics.md): Windows 586 s, Linux
// 768 s, 0 reasoning-leak tokens, no stall, a real HTML file produced and self-corrected against the
// project's own facts.
//
// Usage (Linux, inside a container so it never touches the host — see docs/releasing.md style):
//   HERMES_RT_KEY=... PROVIDER_BASE_URL=https://your-endpoint/v1 PROVIDER_MODEL=your-model \
//   PROJECT_DIR=/task/project SKILLS_DIR=/task/skills-ext PROMPT_FILE=/task/prompt.txt \
//   node --import tsx scripts/coding-task-acceptance.mjs
//
// Usage (Windows, from a checkout, against the extension's own managed runtime):
//   $env:HERMES_RT_KEY=...; node --import tsx scripts/coding-task-acceptance.mjs
//
// Environment:
//   HERMES_RT_KEY       required — API key for the provider
//   PROVIDER_BASE_URL   default https://qwen.rangeltech.net/v1 (the qwen skill's endpoint)
//   PROVIDER_MODEL      default qwen-abliterated
//   DISABLE_THINKING    default true — sets providers.<name>.extra_body.chat_template_kwargs.enable_thinking
//                       (see docs/dev-metrics.md: without this, a tool-heavy turn can burn 900+ s
//                       reasoning without ever emitting a tool call, on this vLLM/qwen3_xml combination)
//   PROJECT_DIR         default <repo>/scripts/.coding-task-acceptance/project — created if missing
//   SKILLS_DIR          optional external skills directory to mount (skills.external_dirs)
//   PROMPT_FILE         default a built-in prompt asking for a short project summary page
//   TASK_TIMEOUT_MS     default 900000 (15 min)
//   DATA_DIR            default <repo>/scripts/.coding-task-acceptance/data — the private HERMES_HOME
//   OPTIONAL_PACKS      comma-separated extra runtime packs beyond core (default: none)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataPaths } from '../src/paths/hermesHome.ts';
import { installRuntime } from '../src/runtime/installer.ts';
import { loadEmbeddedManifest, runtimeForPlatform, selectPacks } from '../src/runtime/manifest.ts';
import { validateRuntime } from '../src/runtime/validator.ts';
import { applyProfile } from '../src/providers/configWriter.ts';
import { apiKeyEnvName } from '../src/providers/profile.ts';
import { buildRuntimeEnv, runCapture } from '../src/runtime/process.ts';
import { AcpClient } from '../src/acpClient.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.HERMES_RT_KEY;
if (!KEY) throw new Error('HERMES_RT_KEY is required');

const BASE_URL = process.env.PROVIDER_BASE_URL || 'https://qwen.rangeltech.net/v1';
const MODEL = process.env.PROVIDER_MODEL || 'qwen-abliterated';
const DISABLE_THINKING = (process.env.DISABLE_THINKING ?? 'true') === 'true';
const SCRATCH = path.join(REPO, 'scripts', '.coding-task-acceptance');
const PROJECT = process.env.PROJECT_DIR || path.join(SCRATCH, 'project');
const DATA = process.env.DATA_DIR || path.join(SCRATCH, 'data');
const SKILLS_DIR = process.env.SKILLS_DIR;
const budgetMs = Number(process.env.TASK_TIMEOUT_MS || 900000);
const optional = (process.env.OPTIONAL_PACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

fs.mkdirSync(PROJECT, { recursive: true });
const defaultPrompt = [
  'Read README.md in this folder (create a short one first if it does not exist) and write a',
  'one-page index.html summarizing it: a title, three bullet points of what it does, and a footer.',
  'Use only facts you can see in the project files. When you are done, stop.',
].join(' ');
let promptFile = process.env.PROMPT_FILE;
if (!promptFile) {
  promptFile = path.join(SCRATCH, 'prompt.txt');
  fs.writeFileSync(promptFile, defaultPrompt);
  if (!fs.existsSync(path.join(PROJECT, 'README.md'))) {
    fs.writeFileSync(path.join(PROJECT, 'README.md'), '# Sample project\n\nA placeholder project for the coding-task acceptance check.\n');
  }
}

const paths = dataPaths(DATA);
const manifest = loadEmbeddedManifest(REPO);
const runtime = runtimeForPlatform(manifest);
if (!runtime) throw new Error(`No runtime is published for ${process.platform}-${process.arch}.`);
const packs = selectPacks(runtime, optional);

console.log(`Installing ${runtime.id} (${packs.map((p) => p.name).join(', ')}) into ${paths.root} ...`);
let lastLine = '';
const active = await installRuntime({
  runtime, packs, paths,
  onProgress: (p) => {
    const line = `${p.phase} ${p.pack ?? ''}`;
    if (line !== lastLine) { lastLine = line; console.log(`  ${line}`); }
  },
});
console.log('Runtime dir:', active.dir);

const validated = await validateRuntime(active.dir, { hermesHome: paths.home });
console.log('Validated. Entry:', validated.entryExe, validated.entryArgs);

const profile = { id: 'acceptance', name: 'Acceptance', baseUrl: BASE_URL, model: MODEL, timeoutSeconds: 120 };
await applyProfile({
  cliExe: validated.cliExe, hermesHome: paths.home,
  statePath: path.join(paths.state, 'applied-profile.json'), profile, force: true,
});

// applyProfile writes the inline `provider: custom` shorthand, which has no field for extra_body.
// Rewrite as a NAMED provider entry so DISABLE_THINKING and future extra_body options apply
// (see docs/dev-metrics.md — the finding that led to this).
const env0 = buildRuntimeEnv(process.env, { hermesHome: paths.home });
async function configSet(key, value) {
  const result = await runCapture(validated.cliExe, ['config', 'set', key, value], env0, 60000);
  if (result.code !== 0) throw new Error(`hermes config set ${key} failed: ${result.stderr || result.stdout}`);
}
if (SKILLS_DIR) await configSet('skills.external_dirs', JSON.stringify([SKILLS_DIR]));
await configSet('providers.acceptance.base_url', BASE_URL);
await configSet('providers.acceptance.api_key', '${' + apiKeyEnvName(profile.id) + '}');
if (DISABLE_THINKING) await configSet('providers.acceptance.extra_body.chat_template_kwargs.enable_thinking', 'false');
await configSet('model.provider', 'acceptance');
await configSet('model.default', MODEL);
console.log(`Provider configured (named, thinking ${DISABLE_THINKING ? 'disabled' : 'left at provider default'}).`);

const env = buildRuntimeEnv(process.env, { hermesHome: paths.home, extra: { [apiKeyEnvName(profile.id)]: KEY } });
const client = new AcpClient(validated.entryExe, () => env, Boolean(process.env.SHOW_STDERR), '');
client.setLaunchArgs(validated.entryArgs);
if (process.env.SHOW_STDERR) client.on('log', (line) => console.error('[hermes]', line));

const t0 = Date.now();
const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0);
let answer = '';
let thoughtChunks = 0;
const toolCalls = [];
client.onNotification((method, params) => {
  if (method !== 'session/update') return;
  const update = params.update ?? {};
  if (update.sessionUpdate === 'agent_message_chunk') answer += update.content?.text ?? '';
  if (update.sessionUpdate === 'agent_thought_chunk') thoughtChunks += 1;
  if (update.sessionUpdate === 'tool_call') { toolCalls.push(update.title); console.log(`[${elapsed()}s] tool start  ${update.title}`); }
  if (update.sessionUpdate === 'tool_call_update' && update.status && update.status !== 'in_progress') {
    console.log(`[${elapsed()}s] tool ${update.status}`);
  }
});
client.onIncomingRequest(async (_method, params) => {
  // Default: keep working, per hermesRangelTech.autoApprovePermissions (see src/extension.ts).
  const options = params.options ?? [];
  const option = options.find((o) => /allow/.test(o.optionId ?? '')) ?? options[0];
  return { outcome: { outcome: 'selected', optionId: option?.optionId } };
});

await client.start();
console.log(`[${elapsed()}s] ACP started`);
const session = await client.call('session/new', { cwd: PROJECT, mcpServers: [] });
console.log(`[${elapsed()}s] session ${session.sessionId}, model ${session.models?.currentModelId}`);
// dont_ask matches the extension's own default (hermesRangelTech.editApprovalMode).
await client.call('session/set_mode', { sessionId: session.sessionId, modeId: 'dont_ask' });

const prompt = fs.readFileSync(promptFile, 'utf8');
let stopReason = 'timed-out';
try {
  const result = await Promise.race([
    client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: prompt }] }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), budgetMs)),
  ]);
  stopReason = result.stopReason;
} finally {
  client.stop();
}
console.log(`[${elapsed()}s] stopReason ${stopReason}`);
console.log(`thought chunks: ${thoughtChunks}, tool calls: ${toolCalls.length}, answer chars: ${answer.length}`);

const generated = fs.readdirSync(PROJECT).some((f) => f !== 'README.md' && fs.statSync(path.join(PROJECT, f)).size > 200);
const ok = stopReason === 'end_turn' && generated;
console.log(ok ? 'PASS: the task completed and produced real output.' : 'FAIL: no clean completion or no output produced — see docs/agentic-reliability-debug.md.');
process.exitCode = ok ? 0 : 1;
