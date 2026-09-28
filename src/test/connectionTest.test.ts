import assert from 'node:assert/strict';
import test from 'node:test';
import { summarize, testConnection } from '../providers/connectionTest';
import type { ProviderProfile } from '../providers/profile';

const profile: ProviderProfile = { id: 'p-1', name: 'Rangel Qwen', baseUrl: 'https://llm.example.com/v1', model: 'qwen', timeoutSeconds: 30 };

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('passes when the endpoint lists the model and completes an inference', async () => {
  const seenAuth: string[] = [];
  const result = await testConnection(profile, 'sk-test-key-123456', {
    fetchImpl: fakeFetch((url, init) => {
      seenAuth.push(String((init?.headers as Record<string, string>).authorization));
      return url.endsWith('/models') ? json({ data: [{ id: 'qwen' }] }) : json({ choices: [{ message: { content: 'OK' } }] });
    }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((s) => s.name), ['reach', 'auth', 'model', 'inference']);
  assert.ok(seenAuth.every((a) => a === 'Bearer sk-test-key-123456'));
});

test('reports an authentication failure with the profile name', async () => {
  const result = await testConnection(profile, 'bad', { fetchImpl: fakeFetch(() => json({ error: 'nope' }, 401)) });
  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1)?.name, 'auth');
  assert.match(result.hint ?? '', /Rangel Qwen/);
});

test('lists available models when the requested one is missing', async () => {
  const result = await testConnection(profile, 'k', { fetchImpl: fakeFetch(() => json({ data: [{ id: 'a' }, { id: 'b' }] })) });
  assert.equal(result.ok, false);
  assert.equal(result.steps.at(-1)?.name, 'model');
  assert.match(result.hint ?? '', /a, b/);
});

test('accepts an endpoint with no /models listing and relies on the inference', async () => {
  const result = await testConnection(profile, 'k', {
    fetchImpl: fakeFetch((url) => (url.endsWith('/models') ? new Response('', { status: 404 }) : json({ choices: [{}] }))),
  });
  assert.equal(result.ok, true);
});

test('classifies DNS, refused and certificate failures', async () => {
  const boom = (code: string, message = 'x'): typeof fetch => (async () => {
    const err = new TypeError('fetch failed') as TypeError & { cause?: unknown };
    err.cause = { code, message };
    throw err;
  }) as typeof fetch;
  const dns = await testConnection(profile, 'k', { fetchImpl: boom('ENOTFOUND') });
  assert.match(dns.steps[0].detail, /DNS/);
  const refused = await testConnection(profile, 'k', { fetchImpl: boom('ECONNREFUSED') });
  assert.match(refused.steps[0].detail, /refused/);
  const tls = await testConnection(profile, 'k', { fetchImpl: boom('UNABLE_TO_VERIFY_LEAF_SIGNATURE') });
  assert.match(tls.steps[0].detail, /certificate/i);
  assert.match(tls.hint ?? '', /corporate/i);
});

test('never leaks the API key from a provider error body', async () => {
  const key = 'sk-topsecret-abcdef123456';
  const result = await testConnection(profile, key, {
    fetchImpl: fakeFetch((url) => (url.endsWith('/models')
      ? json({ data: [{ id: 'qwen' }] })
      : json({ error: { message: `Invalid key ${key} for user` } }, 400))),
  });
  assert.equal(result.ok, false);
  assert.ok(!summarize(result).includes(key));
  assert.match(summarize(result), /\*\*\*/);
});

test('reports rate limiting with a useful hint', async () => {
  const result = await testConnection(profile, 'k', {
    fetchImpl: fakeFetch((url) => (url.endsWith('/models') ? json({ data: [{ id: 'qwen' }] }) : json({ error: 'slow down' }, 429))),
  });
  assert.equal(result.ok, false);
  assert.match(result.hint ?? '', /rate limiting/i);
});
