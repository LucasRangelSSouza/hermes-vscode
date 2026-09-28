import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { RuntimeValidationError, readRuntimeJson, sha256File, validateRuntime } from '../runtime/validator';
import { buildRuntimeEnv, runCapture } from '../runtime/process';

const EXE = process.platform === 'win32' ? '.exe' : '';

interface FakeRuntime { dir: string; cleanup: () => void }

/** A runtime whose "hermes-acp" is a copy of the node binary running a tiny script. */
function fakeRuntime(script: string, json: Record<string, unknown> = {}): FakeRuntime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-val-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.copyFileSync(process.execPath, path.join(dir, 'bin', `hermes-acp${EXE}`));
  fs.writeFileSync(path.join(dir, 'entry.js'), script);
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({
    schema: 1, id: 'hrt-test', hermes: { ref: 'v0', commit: 'c' }, platform: process.platform, arch: process.arch,
    acpProtocolVersion: 1, entry: { exe: `bin/hermes-acp${EXE}`, args: ['entry.js'] }, cli: { exe: `bin/hermes-acp${EXE}` }, ...json,
  }));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) };
}

const GOOD = `
const a = process.argv.slice(2);
if (a.includes('--version')) console.log('0.21.5+test');
else if (a.includes('--check')) console.log('Hermes ACP check OK');
else process.exit(9);
`;

test('validates a working runtime end to end', async () => {
  const r = fakeRuntime(GOOD);
  try {
    const v = await validateRuntime(r.dir, { hermesHome: path.join(r.dir, 'home') });
    assert.equal(v.version, '0.21.5+test');
    assert.equal(v.json.id, 'hrt-test');
    assert.ok(fs.existsSync(v.entryExe));
  } finally { r.cleanup(); }
});

test('reports the executable path and SHA-256 when the self-check fails', async () => {
  const r = fakeRuntime(`
    const a = process.argv.slice(2);
    if (a.includes('--version')) console.log('0.21.5');
    else { console.error('missing dependency'); process.exit(3); }
  `);
  try {
    await assert.rejects(validateRuntime(r.dir, { hermesHome: path.join(r.dir, 'home') }), (err: unknown) => {
      assert.ok(err instanceof RuntimeValidationError);
      assert.equal(err.step, 'check');
      assert.ok(err.exePath && err.exePath.includes('hermes-acp'));
      assert.match(err.exeSha256 ?? '', /^[0-9a-f]{64}$/);
      assert.match(err.message, /missing dependency/);
      return true;
    });
  } finally { r.cleanup(); }
});

test('reports a start failure at the version step', async () => {
  const r = fakeRuntime('process.exit(5);');
  try {
    await assert.rejects(validateRuntime(r.dir, { hermesHome: path.join(r.dir, 'home') }), (err: unknown) => err instanceof RuntimeValidationError && err.step === 'version');
  } finally { r.cleanup(); }
});

test('rejects a runtime built for another platform', async () => {
  const r = fakeRuntime(GOOD, { platform: process.platform === 'win32' ? 'linux' : 'win32' });
  try {
    await assert.rejects(validateRuntime(r.dir, { hermesHome: r.dir }), (err: unknown) => err instanceof RuntimeValidationError && err.step === 'platform');
  } finally { r.cleanup(); }
});

test('rejects runtime.json paths that escape the folder', () => {
  for (const exe of ['../outside/hermes', '/abs/hermes', 'C:\\abs\\hermes', 'bin/../../x']) {
    const r = fakeRuntime(GOOD, { entry: { exe, args: [] } });
    try {
      assert.throws(() => readRuntimeJson(r.dir), (err: unknown) => err instanceof RuntimeValidationError && err.step === 'runtime.json');
    } finally { r.cleanup(); }
  }
});

test('reports a missing or unreadable runtime.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-val-'));
  try {
    assert.throws(() => readRuntimeJson(dir), (err: unknown) => err instanceof RuntimeValidationError);
    fs.writeFileSync(path.join(dir, 'runtime.json'), '{not json');
    assert.throws(() => readRuntimeJson(dir), (err: unknown) => err instanceof RuntimeValidationError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a timed out start is reported as such', async () => {
  const r = fakeRuntime('setInterval(() => {}, 1000);');
  try {
    await assert.rejects(
      validateRuntime(r.dir, { hermesHome: r.dir, timeoutMs: 800 }),
      (err: unknown) => err instanceof RuntimeValidationError && /timed out/i.test(err.message),
    );
  } finally { r.cleanup(); }
});

test('the runtime environment drops Python leakage and sets the private home', () => {
  const env = buildRuntimeEnv(
    { PATH: '/usr/bin', PYTHONHOME: '/x', PYTHONPATH: '/y', VIRTUAL_ENV: '/z', HTTPS_PROXY: 'http://proxy:3128' },
    { hermesHome: '/private/home', extra: { HERMES_RT_KEY_A: 'secret' } },
  );
  assert.equal(env.PYTHONHOME, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  assert.equal(env.VIRTUAL_ENV, undefined);
  assert.equal(env.HERMES_HOME, '/private/home');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.HERMES_RT_KEY_A, 'secret');
  assert.equal(env.HTTPS_PROXY, 'http://proxy:3128', 'proxy settings must pass through');
  assert.equal(env.PATH, '/usr/bin');
});

test('runCapture reports a spawn error instead of throwing', async () => {
  const res = await runCapture(path.join(os.tmpdir(), 'definitely-not-here.exe'), [], process.env, 2000);
  assert.ok(res.spawnError);
  assert.equal(res.code, null);
});

test('sha256File hashes a file', async () => {
  const f = path.join(os.tmpdir(), `hrt-hash-${process.pid}.txt`);
  fs.writeFileSync(f, 'abc');
  try {
    assert.equal(await sha256File(f), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally { fs.rmSync(f, { force: true }); }
});
