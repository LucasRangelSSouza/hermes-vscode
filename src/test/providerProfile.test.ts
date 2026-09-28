import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProfileStore, apiKeyEnvName, isLoopbackHost, newProfileId, normalizeBaseUrl, secretKeyFor, validateProfile,
} from '../providers/profile';
import type { KeyValueStore, ProviderProfile, SecretStore } from '../providers/profile';
import { clearSecrets, redact, registerSecret } from '../secrets/redactor';

function memory(): { state: KeyValueStore; secrets: SecretStore; secretValues: Map<string, string>; stateValues: Map<string, unknown> } {
  const stateValues = new Map<string, unknown>();
  const secretValues = new Map<string, string>();
  return {
    stateValues,
    secretValues,
    state: {
      get: <T>(key: string, fallback: T): T => (stateValues.has(key) ? stateValues.get(key) as T : fallback),
      update: async (key, value) => { if (value === undefined) stateValues.delete(key); else stateValues.set(key, value); },
    },
    secrets: {
      get: async (key) => secretValues.get(key),
      store: async (key, value) => { secretValues.set(key, value); },
      delete: async (key) => { secretValues.delete(key); },
    },
  };
}

const good: ProviderProfile = { id: 'qwen-1a2b', name: 'Rangel Qwen', baseUrl: 'https://llm.example.com/v1/', model: 'qwen-abliterated', timeoutSeconds: 60 };

test('accepts https and loopback http, rejects remote plain http', () => {
  assert.deepEqual(validateProfile(good), []);
  assert.deepEqual(validateProfile({ ...good, baseUrl: 'http://127.0.0.1:8899/v1' }), []);
  assert.deepEqual(validateProfile({ ...good, baseUrl: 'http://localhost:1234/v1' }), []);
  assert.ok(validateProfile({ ...good, baseUrl: 'http://api.example.com/v1' }).some((m) => /http/i.test(m)));
  assert.deepEqual(validateProfile({ ...good, baseUrl: 'http://api.example.com/v1', allowInsecureHttp: true }), []);
});

test('rejects credentials in the URL, bad models and out of range timeouts', () => {
  assert.ok(validateProfile({ ...good, baseUrl: 'https://user:pw@api.example.com/v1' }).some((m) => /credentials/i.test(m)));
  assert.ok(validateProfile({ ...good, model: 'has space' }).length > 0);
  assert.ok(validateProfile({ ...good, model: '' }).length > 0);
  assert.ok(validateProfile({ ...good, timeoutSeconds: 1 }).length > 0);
  assert.ok(validateProfile({ ...good, name: '  ' }).length > 0);
  assert.ok(validateProfile({ ...good, baseUrl: 'not a url' }).length > 0);
});

test('normalizes URLs and detects loopback hosts', () => {
  assert.equal(normalizeBaseUrl(' https://x.example/v1/// '), 'https://x.example/v1');
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isLoopbackHost('example.com'), false);
});

test('derives a stable, environment-safe key variable from the id', () => {
  assert.equal(apiKeyEnvName('qwen-1a2b'), 'HERMES_RT_KEY_QWEN_1A2B');
  assert.match(apiKeyEnvName('we ird/id'), /^HERMES_RT_KEY_[A-Z0-9_]+$/);
  assert.match(newProfileId('Rangel Qwen', () => 0.5), /^rangel-qwen-[0-9a-f]{4}$/);
});

test('stores profiles in state and the key only in secret storage', async () => {
  const m = memory();
  const store = new ProfileStore(m.state, m.secrets);
  await store.save(good, 'sk-very-secret-value');
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].baseUrl, 'https://llm.example.com/v1');
  assert.equal(await store.apiKey(good.id), 'sk-very-secret-value');
  assert.equal(m.secretValues.get(secretKeyFor(good.id)), 'sk-very-secret-value');
  assert.ok(!JSON.stringify([...m.stateValues.values()]).includes('sk-very-secret-value'), 'the key must never reach profile state');
});

test('first saved profile becomes active, removal clears the key and the active pointer', async () => {
  const m = memory();
  const store = new ProfileStore(m.state, m.secrets);
  await store.save(good, 'k1');
  await store.save({ ...good, id: 'other-0001', name: 'Other' }, 'k2');
  assert.equal(store.activeId(), good.id);
  await store.setActive('other-0001');
  assert.equal(store.active()?.name, 'Other');
  await store.remove('other-0001');
  assert.equal(await store.apiKey('other-0001'), undefined);
  assert.equal(store.activeId(), good.id, 'falls back to the remaining profile');
  await assert.rejects(store.setActive('missing'));
});

test('an invalid profile is rejected before anything is stored', async () => {
  const m = memory();
  const store = new ProfileStore(m.state, m.secrets);
  await assert.rejects(store.save({ ...good, baseUrl: 'http://api.example.com/v1' }, 'k'));
  assert.equal(store.list().length, 0);
  assert.equal(m.secretValues.size, 0);
});

test('editing without a new key keeps the stored key', async () => {
  const m = memory();
  const store = new ProfileStore(m.state, m.secrets);
  await store.save(good, 'keep-me-please');
  await store.save({ ...good, model: 'another-model' });
  assert.equal(store.get(good.id)?.model, 'another-model');
  assert.equal(await store.apiKey(good.id), 'keep-me-please');
});

test('the redactor masks registered secrets and common token shapes', () => {
  clearSecrets();
  registerSecret('my-custom-secret-value');
  assert.equal(redact('key=my-custom-secret-value ok'), 'key=*** ok');
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop12345'), 'Authorization: Bearer ***');
  const pat = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'); // built at run time so scanners do not flag the fixture
  assert.equal(redact(`token ${pat}`), 'token ***');
  assert.equal(redact('sk-abcdefghijklmnop1234'), 'sk-***');
  assert.equal(redact('nothing to hide'), 'nothing to hide');
  clearSecrets();
});
