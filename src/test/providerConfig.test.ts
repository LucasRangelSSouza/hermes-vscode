import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { ConfigApplyError, applyProfile, configCommands, profileFingerprint } from '../providers/configWriter';
import type { CommandRunner } from '../providers/configWriter';
import type { ProviderProfile } from '../providers/profile';
import { activeHermesHome, activeHermesHomeOrNull, dataPaths, dataRoot, defaultExistingHermesHome, setActiveHermesHome } from '../paths/hermesHome';

const profile: ProviderProfile = { id: 'qwen-1a2b', name: 'Rangel Qwen', baseUrl: 'https://llm.example.com/v1/', model: 'qwen-abliterated', timeoutSeconds: 60 };

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-cfg-')); }

test('the api key is written as a variable reference, never as a value', () => {
  const cmds = configCommands(profile);
  assert.deepEqual(cmds[0], ['config', 'set', 'model.provider', 'custom']);
  assert.deepEqual(cmds[1], ['config', 'set', 'model.base_url', 'https://llm.example.com/v1']);
  assert.deepEqual(cmds[2], ['config', 'set', 'model.default', 'qwen-abliterated']);
  assert.deepEqual(cmds[3], ['config', 'set', 'model.api_key', '${HERMES_RT_KEY_QWEN_1A2B}']);
});

test('applies once, then skips until the profile changes', async () => {
  const home = tmp();
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner: CommandRunner = async (_exe, args, env) => {
    calls.push({ args, env });
    fs.writeFileSync(path.join(home, 'config.yaml'), 'model: {}\n');
    return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
  };
  try {
    const req = { cliExe: 'hermes', hermesHome: home, statePath: path.join(home, 'state', 'applied.json'), profile, baseEnv: { HERMES_RT_KEY_QWEN_1A2B: 'sk-leak-me', PATH: 'x' }, runner };
    assert.equal(await applyProfile(req), true);
    assert.equal(calls.length, 4);
    assert.equal(await applyProfile(req), false);
    assert.equal(calls.length, 4, 'unchanged profile is not applied again');
    assert.equal(await applyProfile({ ...req, profile: { ...profile, model: 'other' } }), true);
    assert.equal(calls.length, 8);
    assert.equal(await applyProfile({ ...req, force: true }), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the key variable is absent while config is written, so it cannot be expanded to disk', async () => {
  const home = tmp();
  let seen: NodeJS.ProcessEnv | undefined;
  const runner: CommandRunner = async (_e, _a, env) => { seen = env; return { code: 0, stdout: '', stderr: '', timedOut: false }; };
  try {
    await applyProfile({ cliExe: 'hermes', hermesHome: home, statePath: path.join(home, 'a.json'), profile, baseEnv: { HERMES_RT_KEY_QWEN_1A2B: 'sk-must-not-appear', PYTHONHOME: '/bad' }, runner });
    assert.equal(seen?.HERMES_RT_KEY_QWEN_1A2B, undefined);
    assert.equal(seen?.PYTHONHOME, undefined);
    assert.equal(seen?.HERMES_HOME, home);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a failing command surfaces a clear error and does not record the profile as applied', async () => {
  const home = tmp();
  const runner: CommandRunner = async () => ({ code: 2, stdout: '', stderr: 'boom', timedOut: false });
  try {
    const statePath = path.join(home, 'applied.json');
    await assert.rejects(applyProfile({ cliExe: 'hermes', hermesHome: home, statePath, profile, runner }), ConfigApplyError);
    assert.ok(!fs.existsSync(statePath));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the fingerprint changes with url, model and key variable but not with the name', () => {
  const a = profileFingerprint(profile);
  assert.equal(profileFingerprint({ ...profile, name: 'renamed' }), a);
  assert.notEqual(profileFingerprint({ ...profile, model: 'x' }), a);
  assert.notEqual(profileFingerprint({ ...profile, baseUrl: 'https://other.example.com/v1' }), a);
  assert.notEqual(profileFingerprint({ ...profile, id: 'different-0001' }), a);
});

test('data folders follow the platform conventions', () => {
  assert.equal(dataRoot({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\HermesByRangelTech');
  assert.equal(dataRoot({}, 'win32', 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Local\\HermesByRangelTech');
  assert.equal(dataRoot({}, 'linux', '/home/a'), '/home/a/.local/share/hermes-by-rangel-tech');
  assert.equal(dataRoot({ XDG_DATA_HOME: '/data' }, 'linux', '/home/a'), '/data/hermes-by-rangel-tech');
  const p = dataPaths('/home/a/.local/share/hermes-by-rangel-tech', 'linux');
  assert.equal(p.runtime, '/home/a/.local/share/hermes-by-rangel-tech/runtime');
  assert.equal(p.home, '/home/a/.local/share/hermes-by-rangel-tech/home');
  assert.equal(p.state, '/home/a/.local/share/hermes-by-rangel-tech/state');
});

test('an existing Hermes home follows HERMES_HOME, then the platform default', () => {
  assert.equal(defaultExistingHermesHome({ HERMES_HOME: '/custom' }, 'linux', '/home/a'), '/custom');
  assert.equal(defaultExistingHermesHome({}, 'linux', '/home/a'), '/home/a/.hermes');
  assert.equal(defaultExistingHermesHome({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\a'), 'C:\\L\\hermes');
});

test('the active Hermes home is explicit once selected', () => {
  setActiveHermesHome(null);
  assert.equal(activeHermesHomeOrNull(), null);
  assert.ok(activeHermesHome().endsWith('.hermes'));
  setActiveHermesHome('/private/home');
  assert.equal(activeHermesHome(), '/private/home');
  assert.equal(activeHermesHomeOrNull(), '/private/home');
  setActiveHermesHome(null);
});
