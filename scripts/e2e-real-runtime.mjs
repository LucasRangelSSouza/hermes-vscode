// End-to-end check of the real chain on this machine, without VS Code:
//   manifest -> download -> verify -> extract -> validate -> provider config -> AcpClient -> ACP round trip
// It downloads the runtime packs from the GitHub Release, so it needs network and disk space.
//
//   node --import tsx scripts/e2e-real-runtime.mjs
//
// Environment:
//   E2E_PACKS  comma separated optional packs to install besides core (default: none)
//   E2E_ROOT   data folder to use (default: a folder with spaces and non-ASCII characters under the temp dir)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../src/acpClient.ts';
import { dataPaths } from '../src/paths/hermesHome.ts';
import { applyProfile } from '../src/providers/configWriter.ts';
import { apiKeyEnvName } from '../src/providers/profile.ts';
import { installRuntime, readActive } from '../src/runtime/installer.ts';
import { loadEmbeddedManifest, runtimeForPlatform, selectPacks, totalBytes } from '../src/runtime/manifest.ts';
import { buildRuntimeEnv } from '../src/runtime/process.ts';
import { validateRuntime } from '../src/runtime/validator.ts';
import { purgeTerminalSnapshots } from '../src/runtime/terminalSnapshots.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataRoot = process.env.E2E_ROOT ?? path.join(os.tmpdir(), 'hrt e2e çã teste');
const optional = (process.env.E2E_PACKS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const paths = dataPaths(dataRoot);
const KEY = 'sk-e2e-long-key-0123456789abcdef';
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };

function userPath() {
  if (process.platform !== 'win32') return '';
  return execFileSync('powershell', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8' }).trim();
}

const pathBefore = userPath();
console.log(`data folder: ${dataRoot}`);

// 1. install from the embedded manifest
const manifest = loadEmbeddedManifest(root);
const runtime = runtimeForPlatform(manifest);
if (!runtime) throw new Error(`no runtime for ${process.platform}-${process.arch}`);
const packs = selectPacks(runtime, optional);
console.log(`installing ${runtime.id}: ${packs.map((p) => p.name).join(', ')} (${(totalBytes(packs) / 1024 ** 3).toFixed(2)} GB)`);
let lastLine = '';
const started = Date.now();
const active = await installRuntime({
  runtime, packs, paths,
  onProgress: (p) => {
    const line = `${p.phase}${p.pack ? ` ${p.pack}` : ''}`;
    if (line !== lastLine) { lastLine = line; console.log(`  [${((Date.now() - started) / 1000).toFixed(0)}s] ${p.message}`); }
  },
});
check(readActive(paths)?.id === runtime.id, `runtime ${active.id} is active`);
check(active.dir.includes(' ') && /[^\x00-\x7f]/.test(active.dir), 'installed under a path with spaces and non-ASCII characters');

// 2. full validation
const validated = await validateRuntime(active.dir, { hermesHome: paths.home });
check(validated.version.length > 0, `--version and --check pass (reported: ${JSON.stringify(validated.version)})`);

// 3. mock provider + profile applied through the real Hermes CLI
const mockDir = path.join(root, 'docs', 'spikes', 's0');
fs.rmSync(path.join(mockDir, 'mock.log'), { force: true });
const mock = spawn(process.execPath, ['mock-openai.js'], { cwd: mockDir, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));
const profile = { id: 'e2e-0001', name: 'E2E', baseUrl: 'http://127.0.0.1:8899/v1', model: 'mock-model', timeoutSeconds: 30 };
try {
  const applied = await applyProfile({
    cliExe: validated.cliExe, hermesHome: paths.home, statePath: path.join(paths.state, 'applied-profile.json'), profile,
  });
  check(applied === true || fs.existsSync(path.join(paths.home, 'config.yaml')), 'provider settings written through hermes config set (or already applied from a reused home)');
  const cfg = fs.readFileSync(path.join(paths.home, 'config.yaml'), 'utf8');
  check(cfg.includes('${' + apiKeyEnvName(profile.id) + '}'), 'config.yaml holds the key placeholder');
  check(!cfg.includes(KEY), 'config.yaml does not contain the key');

  // 4. real AcpClient, real runtime
  const env = buildRuntimeEnv(process.env, { hermesHome: paths.home, extra: { [apiKeyEnvName(profile.id)]: KEY } });
  const client = new AcpClient(validated.entryExe, () => env, false, '');
  client.setLaunchArgs(validated.entryArgs);
  const text = [];
  const tools = [];
  client.onNotification((method, params) => {
    if (method !== 'session/update') return;
    const u = params.update ?? {};
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) text.push(u.content.text);
    if (u.sessionUpdate === 'tool_call_update') tools.push(u.status);
  });
  client.onIncomingRequest(async (_m, p) => {
    const opt = (p.options ?? []).find((o) => /allow/.test(o.optionId ?? '')) ?? p.options?.[0];
    return { outcome: { outcome: 'selected', optionId: opt?.optionId } };
  });
  await client.start();
  check(client.running, 'AcpClient started the runtime and completed initialize');
  const cwd = path.join(dataRoot, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  const session = await client.call('session/new', { cwd, mcpServers: [] });
  check(Boolean(session.sessionId), `session created (model ${session.models?.currentModelId ?? 'n/a'})`);
  const r1 = await client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'say hello' }] });
  check(r1.stopReason === 'end_turn' && text.join('').includes('Hello from the mock'), 'streamed reply received');
  text.length = 0;
  await client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'RUNTOOL please' }] });
  check(text.join('').includes('hello-from-bash') && tools.includes('completed'), 'terminal tool ran through the runtime shell');
  const snapshotDir = path.join(paths.home, 'cache', 'terminal');
  const beforePurge = fs.existsSync(snapshotDir)
    ? fs.readdirSync(snapshotDir).some((f) => fs.readFileSync(path.join(snapshotDir, f), 'utf8').includes(KEY))
    : false;
  check(beforePurge, 'known finding: the terminal tool writes the key into a shell snapshot on disk (cache/terminal)');
  purgeTerminalSnapshots(paths.home);
  const afterPurge = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir).some((f) => f.startsWith('hermes-snap-')) : true;
  check(!afterPurge, 'purgeTerminalSnapshots removes the snapshot (called before every launch and on deactivate)');
  client.stop();
  await new Promise((r) => setTimeout(r, 1500));

  // 5. the key reached the provider, only through the environment
  const log = fs.readFileSync(path.join(mockDir, 'mock.log'), 'utf8').split('\n').filter((l) => l.includes('chat/completions')).map((l) => JSON.parse(l));
  check(log.length >= 2 && log.every((l) => l.auth === `Bearer ${KEY}`), 'the API key reached the provider from the environment');
} finally {
  mock.kill();
}

// 6. no side effects: user PATH untouched, no processes left behind
if (process.platform === 'win32') {
  check(userPath() === pathBefore, 'the user PATH was not modified');
  const left = execFileSync('powershell', ['-NoProfile', '-Command',
    `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${active.dir.replace(/'/g, "''")}') }).Count`], { encoding: 'utf8' }).trim();
  check(left === '0', `no runtime processes left running (${left})`);
}
const secretsOnDisk = execFileSync(process.platform === 'win32' ? 'powershell' : 'grep',
  process.platform === 'win32'
    ? ['-NoProfile', '-Command', `@(Get-ChildItem -Recurse -File -Force '${paths.home.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Where-Object { $_.Length -lt 5MB } | Select-String -SimpleMatch '${KEY}' -List -ErrorAction SilentlyContinue).Count`]
    : ['-rl', KEY, paths.home], { encoding: 'utf8' }).trim();
check(secretsOnDisk === '0' || secretsOnDisk === '', 'after the purge, the API key is not written anywhere under the Hermes home');

console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nall checks passed');
process.exit(failures.length ? 1 : 0);
