import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';

const moduleLoader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithVscodeStub(
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};

// Load after installing the VS Code runtime stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SessionStore } = require('../sessionStore') as typeof import('../sessionStore');
moduleLoader._load = originalLoad;

test('renames the session bound to a semantic ACP title update', () => {
  const state = new Map<string, unknown>([
    ['hermesRangelTech.sessions', [
      { id: 'local-a', title: 'First message fallback', createdAt: 1, messages: [], acpSessionId: 'acp-a' },
      { id: 'local-b', title: 'Other session', createdAt: 2, messages: [], acpSessionId: 'acp-b' },
    ]],
  ]);
  const context = {
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const store = new SessionStore(context as never);

  assert.equal(store.renameByAcpSessionId('acp-a', 'GitLab Issue #548 recovery'), true);
  assert.deepEqual(store.allSessions().map(session => session.title), [
    'GitLab Issue #548 recovery',
    'Other session',
  ]);
});
