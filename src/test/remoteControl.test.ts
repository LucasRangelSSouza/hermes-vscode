import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type { SessionUpdateEvent, SessionUpdateHandler } from '../types';

const moduleLoader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleLoader._load;
const configValues: Record<string, string> = { 'remote.baseUrl': 'http://api.test', 'remote.deviceName': '' };
moduleLoader._load = function loadWithVscodeStub(
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
  if (request === 'vscode') {
    return {
      workspace: { getConfiguration: (_ns: string) => ({ get: (key: string) => configValues[key] }) },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Load after installing the VS Code runtime stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const remoteControl = require('../remoteControl') as typeof import('../remoteControl');
moduleLoader._load = originalLoad;

const { pairDevice, pairedDevice, unpairDevice, RemoteControlError, RemoteSessionPublisher } = remoteControl;

function fakeContext() {
  const secretsStore = new Map<string, string>();
  const globalStateStore = new Map<string, unknown>();
  return {
    extension: { packageJSON: { version: '0.1.0-test' } },
    secrets: {
      store: async (k: string, v: string) => { secretsStore.set(k, v); },
      get: async (k: string) => secretsStore.get(k),
      delete: async (k: string) => { secretsStore.delete(k); },
    },
    globalState: {
      get: <T>(k: string): T | undefined => globalStateStore.get(k) as T | undefined,
      update: async (k: string, v: unknown) => { globalStateStore.set(k, v); },
    },
  } as unknown as import('vscode').ExtensionContext;
}

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ ok: boolean; status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit = {}): Promise<Response> => {
    calls.push({ url, init });
    const next = responses.shift() ?? { ok: true, json: {} };
    return {
      ok: next.ok,
      status: next.status ?? (next.ok ? 200 : 400),
      json: async () => next.json,
    } as Response;
  };
  return { impl, calls };
}

test('pairDevice stores the device credential and returns the device on success', async () => {
  const context = fakeContext();
  const { impl, calls } = fakeFetch([
    { ok: true, json: { credential: 'dev-cred-1', device: { id: 'd1', tenant_id: 't1', name: 'Notebook' } } },
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    const device = await pairDevice(context, 'user@example.com', 'senha-forte');
    assert.deepEqual(device, { id: 'd1', tenantId: 't1', name: 'Notebook' });
    assert.equal(await context.secrets.get('hermesRangelTech/remote/deviceCredential'), 'dev-cred-1');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/hermes\/devices\/pair$/);
    const body = JSON.parse(calls[0].init.body as string);
    assert.equal(body.email, 'user@example.com');
    assert.equal(body.password, 'senha-forte');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pairDevice raises RemoteControlError with the server detail on failure', async () => {
  const context = fakeContext();
  const { impl } = fakeFetch([{ ok: false, status: 401, json: { detail: 'Credenciais invalidas.' } }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await assert.rejects(
      () => pairDevice(context, 'user@example.com', 'errada'),
      (err: unknown) => err instanceof RemoteControlError && err.message === 'Credenciais invalidas.',
    );
    assert.equal(await context.secrets.get('hermesRangelTech/remote/deviceCredential'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('pairedDevice is undefined unless both the device record and credential are present', async () => {
  const context = fakeContext();
  assert.equal(await pairedDevice(context), undefined);
  await context.globalState.update('hermesRangelTech.remoteDevice', { id: 'd1', tenantId: 't1', name: 'X' });
  assert.equal(await pairedDevice(context), undefined, 'credential alone is missing');
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  assert.deepEqual(await pairedDevice(context), { id: 'd1', tenantId: 't1', name: 'X' });
});

test('unpairDevice best-effort revokes remotely and always clears local state', async () => {
  const context = fakeContext();
  await context.globalState.update('hermesRangelTech.remoteDevice', { id: 'd1', tenantId: 't1', name: 'X' });
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  const { impl, calls } = fakeFetch([{ ok: true, json: {} }]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    await unpairDevice(context);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/hermes\/devices\/d1\/revoke$/);
    assert.equal(await pairedDevice(context), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('unpairDevice clears local state even when the remote revoke call throws', async () => {
  const context = fakeContext();
  await context.globalState.update('hermesRangelTech.remoteDevice', { id: 'd1', tenantId: 't1', name: 'X' });
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
  try {
    await assert.doesNotReject(() => unpairDevice(context));
    assert.equal(await pairedDevice(context), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function fakeSession() {
  const handlers: SessionUpdateHandler[] = [];
  return {
    manager: { onUpdate: (h: SessionUpdateHandler) => { handlers.push(h); } },
    emit: (event: SessionUpdateEvent) => { for (const h of handlers) h(event); },
  };
}

test('RemoteSessionPublisher.attach without a paired credential does not call the network', async () => {
  const context = fakeContext();
  const { manager } = fakeSession();
  const { impl, calls } = fakeFetch([]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    const publisher = new RemoteSessionPublisher(
      context, manager as never, () => {}, async () => {}, () => true,
    );
    await publisher.attach({ externalSessionId: 'ext-1', workspacePath: '/tmp/ws' });
    assert.equal(calls.length, 0);
    publisher.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RemoteSessionPublisher runs a remote command end-to-end: upsert, transitions, local prompt, completion', async () => {
  const context = fakeContext();
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  const { manager, emit } = fakeSession();
  const logs: string[] = [];
  const prompts: string[] = [];

  const responses: Array<{ ok: boolean; json: unknown }> = [
    { ok: true, json: { id: 'session-1' } }, // upsert idle (attach)
    { ok: true, json: [{ id: 'cmd-1', session_id: 'session-1', payload: { text: 'gere uma tela de cadastro' } }] }, // pending
    { ok: true, json: {} }, // transition accepted
    { ok: true, json: { id: 'session-1' } }, // upsert running
    { ok: true, json: {} }, // transition running
    { ok: true, json: {} }, // transition completed
    { ok: true, json: { id: 'session-1' } }, // upsert idle (finally)
  ];
  const { impl, calls } = fakeFetch(responses);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    const publisher = new RemoteSessionPublisher(
      context,
      manager as never,
      line => logs.push(line),
      async text => {
        prompts.push(text);
        // Simulate the Hermes turn finishing asynchronously, like the real session would.
        setTimeout(() => emit({ session_id: 'session-1', done: true } as SessionUpdateEvent), 5);
      },
      () => true,
    );
    await publisher.attach({ externalSessionId: 'ext-1', workspacePath: '/tmp/ws' });
    await (publisher as unknown as { pollOnce(): Promise<void> }).pollOnce();
    // runCommand is fire-and-forget from pollOnce; wait for all queued microtasks/timers to settle.
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepEqual(prompts, ['gere uma tela de cadastro']);
    const transitionCalls = calls.filter(c => c.url.includes('/commands/cmd-1/transition'));
    const statuses = transitionCalls.map(c => JSON.parse(c.init.body as string).status);
    assert.deepEqual(statuses, ['accepted', 'running', 'completed']);
    publisher.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RemoteSessionPublisher waits for the local session to go idle so an unrelated in-flight local turn cannot be mistaken for the remote command finishing', async () => {
  // Regression for a real live bug (2026-09-28): a person had just typed a
  // message locally; a remote command arrived while that turn was still
  // running, got queued behind it, and the *local* turn's `done` resolved
  // the remote command as completed before the remote instruction had even
  // been sent. The fix waits for the local session to be genuinely idle
  // before arming the completion signal.
  const context = fakeContext();
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  const { manager, emit } = fakeSession();
  const prompts: string[] = [];
  let idle = false; // a local turn is already running when the command arrives

  const responses: Array<{ ok: boolean; json: unknown }> = Array.from(
    { length: 20 },
    () => ({ ok: true, json: { id: 'session-1' } }),
  );
  responses[1] = { ok: true, json: [{ id: 'cmd-1', session_id: 'session-1', payload: { text: 'gere uma tela de cadastro' } }] };
  const { impl, calls } = fakeFetch(responses);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    const publisher = new RemoteSessionPublisher(
      context,
      manager as never,
      () => {},
      async text => { prompts.push(text); },
      () => idle,
    );
    await publisher.attach({ externalSessionId: 'ext-1', workspacePath: '/tmp/ws' });
    await (publisher as unknown as { pollOnce(): Promise<void> }).pollOnce();

    // The stray local turn finishes while the remote command is still
    // waiting for idle. With the fix this must be a no-op for the command.
    emit({ session_id: 'session-1', done: true } as SessionUpdateEvent);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(prompts, [], 'the remote instruction must not have been sent yet');
    let statuses = calls
      .filter(c => c.url.includes('/commands/cmd-1/transition'))
      .map(c => JSON.parse(c.init.body as string).status);
    assert.deepEqual(statuses, ['accepted'], 'must not be completed by the stray done');

    // Now the local session actually becomes free.
    idle = true;
    // Give the 300ms idle-poll time to notice and send the real instruction.
    for (let i = 0; i < 20 && prompts.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(prompts, ['gere uma tela de cadastro'], 'the remote instruction runs once idle');

    // Only now does the matching done arrive, completing the command.
    emit({ session_id: 'session-1', done: true } as SessionUpdateEvent);
    await new Promise(resolve => setTimeout(resolve, 30));
    statuses = calls
      .filter(c => c.url.includes('/commands/cmd-1/transition'))
      .map(c => JSON.parse(c.init.body as string).status);
    assert.deepEqual(statuses, ['accepted', 'running', 'completed']);
    publisher.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('RemoteSessionPublisher rejects a command with no instruction text without touching the local session', async () => {
  const context = fakeContext();
  await context.secrets.store('hermesRangelTech/remote/deviceCredential', 'cred');
  const { manager } = fakeSession();
  const prompts: string[] = [];
  const responses: Array<{ ok: boolean; json: unknown }> = [
    { ok: true, json: { id: 'session-1' } }, // upsert idle (attach)
    { ok: true, json: [{ id: 'cmd-2', session_id: 'session-1', payload: {} }] }, // pending, no text
    { ok: true, json: {} }, // transition rejected
  ];
  const { impl, calls } = fakeFetch(responses);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = impl as typeof fetch;
  try {
    const publisher = new RemoteSessionPublisher(
      context, manager as never, () => {}, async text => { prompts.push(text); }, () => true,
    );
    await publisher.attach({ externalSessionId: 'ext-1', workspacePath: '/tmp/ws' });
    await (publisher as unknown as { pollOnce(): Promise<void> }).pollOnce();
    await new Promise(resolve => setTimeout(resolve, 20));

    assert.deepEqual(prompts, []);
    const transitionCalls = calls.filter(c => c.url.includes('/commands/cmd-2/transition'));
    assert.equal(JSON.parse(transitionCalls[0].init.body as string).status, 'rejected');
    publisher.dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
