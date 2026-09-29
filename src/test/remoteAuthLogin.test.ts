import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import Module from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SessionManager } from '../sessionManager';

const moduleLoader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = moduleLoader._load;
moduleLoader._load = function loadWithVscodeStub(
  request: string,
  parent: unknown,
  isMain: boolean,
): unknown {
  if (request === 'vscode') {
    return {
      Uri: {
        file: (fsPath: string) => ({ fsPath }),
        joinPath: (...parts: Array<{ fsPath?: string } | string>) => ({
          fsPath: parts.map(part => typeof part === 'string' ? part : part.fsPath ?? '').join('/'),
        }),
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: '/workspace' } }],
        asRelativePath: (value: { fsPath?: string } | string) =>
          typeof value === 'string' ? value : value.fsPath ?? '',
      },
      window: {
        activeTextEditor: undefined,
        tabGroups: { all: [] },
        showInputBox: async (): Promise<string | undefined> => undefined,
        showWarningMessage: async (): Promise<string | undefined> => undefined,
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChatPanelProvider } = require('../chatPanel') as typeof import('../chatPanel');
moduleLoader._load = originalLoad;

class NoopClient {
  onNotification(): void {}
  onIncomingRequest(): void {}
  async call(): Promise<unknown> { return {}; }
  notify(): void {}
}

function makeProvider() {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-remote-login-'));
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: () => undefined,
      update: async () => {},
    },
  };
  const session = new SessionManager(new NoopClient() as never);
  const provider = new ChatPanelProvider(
    { fsPath: '/extension' } as never,
    session,
    'test-model',
    'test-version',
    context as never,
  );
  const posted: Array<Record<string, unknown>> = [];
  const subject = provider as unknown as {
    post(message: Record<string, unknown>): void;
    handleFromWebview(message: Record<string, unknown>): Promise<void>;
    setRemoteAuthController(controller: unknown): void;
  };
  subject.post = (msg) => { posted.push(msg); };
  return { subject, posted, cleanup: () => rmSync(storageRoot, { recursive: true, force: true }) };
}

test('setRemoteAuthController immediately renders the current pairing state', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setRemoteAuthController({
      isConfigured: () => true,
      currentDevice: async () => ({ name: 'MINDLAB-001110' }),
      login: async () => ({ name: 'x' }),
      logout: async () => {},
    });
    await new Promise(resolve => setImmediate(resolve));

    const states = posted.filter(m => m.type === 'remoteAuthState');
    assert.equal(states.length, 1);
    assert.deepEqual(states[0], {
      type: 'remoteAuthState',
      remoteConfigured: true,
      remotePaired: true,
      remoteDeviceName: 'MINDLAB-001110',
      remoteBusy: false,
      remoteError: undefined,
    });
  } finally {
    cleanup();
  }
});

test('remoteLogin posts a busy state, then success with the paired device', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let paired = false;
    subject.setRemoteAuthController({
      isConfigured: () => true,
      currentDevice: async () => (paired ? { name: 'Notebook' } : undefined),
      login: async (email: string, password: string) => {
        assert.equal(email, 'lucas@example.com');
        assert.equal(password, 'senha-forte');
        paired = true;
        return { name: 'Notebook' };
      },
      logout: async () => {},
    });
    await new Promise(resolve => setImmediate(resolve));
    posted.length = 0;

    await subject.handleFromWebview({ type: 'remoteLogin', text: 'lucas@example.com', data: 'senha-forte' });

    const states = posted.filter(m => m.type === 'remoteAuthState');
    assert.equal(states.length, 2, 'busy, then settled');
    assert.equal(states[0].remoteBusy, true);
    assert.equal(states[0].remotePaired, false);
    assert.equal(states[1].remoteBusy, false);
    assert.equal(states[1].remotePaired, true);
    assert.equal(states[1].remoteDeviceName, 'Notebook');
  } finally {
    cleanup();
  }
});

test('remoteLogin reports the failure without ever claiming to be paired', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setRemoteAuthController({
      isConfigured: () => true,
      currentDevice: async () => undefined,
      login: async () => { throw new Error('Email ou senha inválidos'); },
      logout: async () => {},
    });
    await new Promise(resolve => setImmediate(resolve));
    posted.length = 0;

    await subject.handleFromWebview({ type: 'remoteLogin', text: 'lucas@example.com', data: 'wrong' });

    const states = posted.filter(m => m.type === 'remoteAuthState');
    const final = states.at(-1);
    assert.equal(final?.remotePaired, false);
    assert.equal(final?.remoteBusy, false);
    assert.equal(final?.remoteError, 'Email ou senha inválidos');
  } finally {
    cleanup();
  }
});

test('remoteLogin does nothing without email or password (blank submit)', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let loginCalled = false;
    subject.setRemoteAuthController({
      isConfigured: () => true,
      currentDevice: async () => undefined,
      login: async () => { loginCalled = true; return { name: 'x' }; },
      logout: async () => {},
    });
    await new Promise(resolve => setImmediate(resolve));
    posted.length = 0;

    await subject.handleFromWebview({ type: 'remoteLogin', text: '', data: '' });
    await subject.handleFromWebview({ type: 'remoteLogin', text: 'lucas@example.com' });

    assert.equal(loginCalled, false);
    assert.deepEqual(posted.filter(m => m.type === 'remoteAuthState'), []);
  } finally {
    cleanup();
  }
});

test('remoteLogout calls the controller and refreshes to signed-out state', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let loggedOut = false;
    subject.setRemoteAuthController({
      isConfigured: () => true,
      currentDevice: async () => (loggedOut ? undefined : { name: 'Notebook' }),
      login: async () => ({ name: 'x' }),
      logout: async () => { loggedOut = true; },
    });
    await new Promise(resolve => setImmediate(resolve));
    posted.length = 0;

    await subject.handleFromWebview({ type: 'remoteLogout' });

    assert.equal(loggedOut, true);
    const final = posted.filter(m => m.type === 'remoteAuthState').at(-1);
    assert.equal(final?.remotePaired, false);
  } finally {
    cleanup();
  }
});

test('remoteLogin/remoteLogout are no-ops before any controller is set', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    await subject.handleFromWebview({ type: 'remoteLogin', text: 'a@b.com', data: 'x' });
    await subject.handleFromWebview({ type: 'remoteLogout' });
    assert.deepEqual(posted.filter(m => m.type === 'remoteAuthState'), []);
  } finally {
    cleanup();
  }
});

test('the login overlay never renders when remote control is not configured', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setRemoteAuthController({
      isConfigured: () => false,
      currentDevice: async () => undefined,
      login: async () => ({ name: 'x' }),
      logout: async () => {},
    });
    await new Promise(resolve => setImmediate(resolve));

    const state = posted.find(m => m.type === 'remoteAuthState');
    assert.equal(state?.remoteConfigured, false);
  } finally {
    cleanup();
  }
});
