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

type ProviderSettingsInput = import('../chatPanel').ProviderSettingsInput;

class NoopClient {
  onNotification(): void {}
  onIncomingRequest(): void {}
  async call(): Promise<unknown> { return {}; }
  notify(): void {}
}

function makeProvider() {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-settings-'));
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: { get: () => undefined, update: async () => {} },
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
    setProviderSettingsController(controller: unknown): void;
  };
  subject.post = (msg) => { posted.push(msg); };
  return { subject, posted, cleanup: () => rmSync(storageRoot, { recursive: true, force: true }) };
}

test('settingsOpen reports the currently active provider, never the api key itself', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setProviderSettingsController({
      current: () => ({ name: 'Qwen VM', baseUrl: 'https://qwen.example/v1', model: 'qwen-abliterated', hasKey: true }),
      save: async () => {},
      test: async () => ({ ok: true, summary: 'ok' }),
    });

    await subject.handleFromWebview({ type: 'settingsOpen' });

    const state = posted.find(m => m.type === 'settingsState');
    assert.deepEqual(state, {
      type: 'settingsState',
      settingsProviderName: 'Qwen VM',
      settingsProviderBaseUrl: 'https://qwen.example/v1',
      settingsProviderModel: 'qwen-abliterated',
      settingsProviderHasKey: true,
      settingsBusy: false,
      settingsError: undefined,
      settingsTestOk: undefined,
      settingsTestSummary: undefined,
      settingsSaved: undefined,
    });
    assert.ok(!('apiKey' in state!), 'the stored key itself must never round-trip to the webview');
  } finally {
    cleanup();
  }
});

test('settingsSaveProvider saves and confirms, without the busy state left stuck on', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    const saved: unknown[] = [];
    subject.setProviderSettingsController({
      current: () => undefined,
      save: async (input: ProviderSettingsInput) => { saved.push(input); },
      test: async () => ({ ok: true, summary: 'ok' }),
    });

    await subject.handleFromWebview({
      type: 'settingsSaveProvider',
      providerName: 'Qwen VM', providerBaseUrl: 'https://qwen.example/v1',
      providerModel: 'qwen-abliterated', providerApiKey: 'sk-secret',
    });

    assert.deepEqual(saved, [{
      name: 'Qwen VM', baseUrl: 'https://qwen.example/v1', model: 'qwen-abliterated',
      apiKey: 'sk-secret', allowInsecureHttp: undefined,
    }]);
    const states = posted.filter(m => m.type === 'settingsState');
    assert.equal(states.at(-1)?.settingsSaved, true);
    assert.equal(states.at(-1)?.settingsBusy, false);
  } finally {
    cleanup();
  }
});

test('settingsSaveProvider refuses a blank form without calling save', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let saveCalled = false;
    subject.setProviderSettingsController({
      current: () => undefined,
      save: async () => { saveCalled = true; },
      test: async () => ({ ok: true, summary: 'ok' }),
    });

    await subject.handleFromWebview({ type: 'settingsSaveProvider', providerName: '', providerBaseUrl: '', providerModel: '' });

    assert.equal(saveCalled, false);
    const state = posted.find(m => m.type === 'settingsState');
    assert.ok(String(state?.settingsError ?? '').length > 0);
  } finally {
    cleanup();
  }
});

test('settingsSaveProvider reports the failure and clears the busy flag on error', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setProviderSettingsController({
      current: () => undefined,
      save: async () => { throw new Error('The base URL is not a valid URL.'); },
      test: async () => ({ ok: true, summary: 'ok' }),
    });

    await subject.handleFromWebview({
      type: 'settingsSaveProvider', providerName: 'x', providerBaseUrl: 'not a url', providerModel: 'x',
    });

    const final = posted.filter(m => m.type === 'settingsState').at(-1);
    assert.equal(final?.settingsError, 'The base URL is not a valid URL.');
    assert.equal(final?.settingsBusy, false);
  } finally {
    cleanup();
  }
});

test('settingsTestProvider surfaces the connection result without saving anything', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let saveCalled = false;
    subject.setProviderSettingsController({
      current: () => undefined,
      save: async () => { saveCalled = true; },
      test: async (input: ProviderSettingsInput) => {
        assert.equal(input.baseUrl, 'https://qwen.example/v1');
        return { ok: false, summary: 'FAIL  reach: could not connect' };
      },
    });

    await subject.handleFromWebview({
      type: 'settingsTestProvider', providerName: 'Qwen VM', providerBaseUrl: 'https://qwen.example/v1', providerModel: 'qwen-abliterated',
    });

    assert.equal(saveCalled, false);
    const final = posted.filter(m => m.type === 'settingsState').at(-1);
    assert.equal(final?.settingsTestOk, false);
    assert.equal(final?.settingsTestSummary, 'FAIL  reach: could not connect');
  } finally {
    cleanup();
  }
});

test('settingsOpen/settingsSaveProvider/settingsTestProvider are no-ops before any controller is set', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    await subject.handleFromWebview({ type: 'settingsOpen' });
    await subject.handleFromWebview({ type: 'settingsSaveProvider', providerName: 'x', providerBaseUrl: 'https://x', providerModel: 'x' });
    await subject.handleFromWebview({ type: 'settingsTestProvider', providerName: 'x', providerBaseUrl: 'https://x', providerModel: 'x' });
    assert.deepEqual(posted.filter(m => m.type === 'settingsState'), []);
  } finally {
    cleanup();
  }
});
