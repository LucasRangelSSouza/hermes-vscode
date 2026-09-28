import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ManifestError, TRUSTED_RELEASE_PREFIX, parseRuntimeManifest, platformKey, runtimeForPlatform, selectPacks, totalBytes,
} from '../runtime/manifest';

const SHA = 'a'.repeat(64);

function pack(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const file = `hermes-runtime-win32-x64-${name}-hrt-1.tar.gz`;
  return { name, file, bytes: 1000, sha256: SHA, required: name === 'core', url: `${TRUSTED_RELEASE_PREFIX}runtime-hrt-1/${file}`, ...extra };
}

function manifest(packs: Array<Record<string, unknown>> = [pack('core'), pack('browser')]): unknown {
  return {
    schema: 1,
    runtimes: { 'win32-x64': { id: 'hrt-1', platform: 'win32-x64', hermes: { ref: 'v0.21.4', commit: 'abc' }, packs } },
  };
}

test('accepts a well formed manifest and selects packs', () => {
  const parsed = parseRuntimeManifest(manifest());
  const runtime = runtimeForPlatform(parsed, 'win32-x64');
  assert.ok(runtime);
  assert.deepEqual(selectPacks(runtime, []).map((p) => p.name), ['core']);
  assert.deepEqual(selectPacks(runtime, ['browser', 'nope']).map((p) => p.name), ['core', 'browser']);
  assert.equal(totalBytes(selectPacks(runtime, ['browser'])), 2000);
  assert.equal(runtimeForPlatform(parsed, 'darwin-arm64'), null);
});

test('rejects a download URL outside the trusted release prefix', () => {
  assert.throws(() => parseRuntimeManifest(manifest([pack('core', { url: 'https://evil.example/hermes-runtime-win32-x64-core-hrt-1.tar.gz' })])), ManifestError);
  assert.throws(() => parseRuntimeManifest(manifest([pack('core', { url: 'http://github.com/LucasRangelSSouza/hermes-vscode/releases/download/x/y.tar.gz' })])), ManifestError);
});

test('rejects a URL whose file name differs from the declared file', () => {
  assert.throws(() => parseRuntimeManifest(manifest([pack('core', { file: 'other.tar.gz' })])), ManifestError);
});

test('rejects bad hashes, sizes, names and duplicates', () => {
  assert.throws(() => parseRuntimeManifest(manifest([pack('core', { sha256: 'xyz' })])), ManifestError);
  assert.throws(() => parseRuntimeManifest(manifest([pack('core', { bytes: 0 })])), ManifestError);
  assert.throws(() => parseRuntimeManifest(manifest([pack('Core Pack')])), ManifestError);
  assert.throws(() => parseRuntimeManifest(manifest([pack('core'), pack('core')])), ManifestError);
});

test('requires a required core pack and a known schema', () => {
  assert.throws(() => parseRuntimeManifest(manifest([pack('browser')])), ManifestError);
  assert.throws(() => parseRuntimeManifest({ schema: 2, runtimes: {} }), ManifestError);
  assert.throws(() => parseRuntimeManifest(null), ManifestError);
});

test('rejects a platform key that does not match the runtime', () => {
  const m = manifest() as { runtimes: Record<string, { platform: string }> };
  m.runtimes['win32-x64'].platform = 'linux-x64';
  assert.throws(() => parseRuntimeManifest(m), ManifestError);
});

test('builds the platform key from platform and arch', () => {
  assert.equal(platformKey('win32', 'x64'), 'win32-x64');
  assert.equal(platformKey('linux', 'arm64'), 'linux-arm64');
});
