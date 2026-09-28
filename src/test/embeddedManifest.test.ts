import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import { loadEmbeddedManifest, runtimeForPlatform } from '../runtime/manifest';

const root = path.resolve(__dirname, '..', '..');
const manifestFile = path.join(root, 'runtime-manifest', 'manifest.json');

test('the manifest embedded in the extension is valid and covers Windows and Linux x64', () => {
  assert.ok(fs.existsSync(manifestFile), 'runtime-manifest/manifest.json must be committed (scripts/sync-runtime-manifest.mjs)');
  const manifest = loadEmbeddedManifest(root);
  for (const key of ['win32-x64', 'linux-x64']) {
    const runtime = runtimeForPlatform(manifest, key);
    assert.ok(runtime, `no runtime for ${key}`);
    assert.ok(runtime.packs.some((p) => p.name === 'core' && p.required));
    assert.ok(runtime.packs.every((p) => p.bytes < 2 * 1024 ** 3), 'every pack must fit a GitHub release asset');
  }
});

test('both platforms ship the same runtime id and Hermes commit', () => {
  const manifest = loadEmbeddedManifest(root);
  const win = runtimeForPlatform(manifest, 'win32-x64');
  const linux = runtimeForPlatform(manifest, 'linux-x64');
  assert.equal(win?.id, linux?.id);
  assert.equal(win?.hermes.commit, linux?.hermes.commit);
});
