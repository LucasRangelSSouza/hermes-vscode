import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { purgeTerminalSnapshots } from '../runtime/terminalSnapshots';

test('removes Hermes terminal snapshots, which can hold the provider API key in the clear', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-snap-'));
  try {
    const dir = path.join(home, 'cache', 'terminal');
    fs.mkdirSync(dir, { recursive: true });
    const snap = path.join(dir, 'hermes-snap-b76878f74c0d.sh');
    fs.writeFileSync(snap, 'declare -x HERMES_RT_KEY_E2E_0001="sk-should-not-persist"\n');
    const other = path.join(dir, 'not-a-snapshot.txt');
    fs.writeFileSync(other, 'keep me');

    purgeTerminalSnapshots(home);

    assert.ok(!fs.existsSync(snap), 'the snapshot must be removed');
    assert.ok(fs.existsSync(other), 'only Hermes snapshot files are touched');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('does nothing when there is no terminal cache yet', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-snap-'));
  try {
    assert.doesNotThrow(() => purgeTerminalSnapshots(home));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
