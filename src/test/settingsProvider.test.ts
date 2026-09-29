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
type ProviderSettingsController = import('../chatPanel').ProviderSettingsController;

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

/** Every test only overrides what it cares about; the rest behave like a
 * fresh install with no profiles saved yet. */
function stubController(overrides: Partial<ProviderSettingsController> = {}): ProviderSettingsController {
  return {
    current: () => undefined,
    save: async () => {},
    test: async () => ({ ok: true, summary: 'ok' }),
    list: () => [],
    select: async () => undefined,
    remove: async () => {},
    ...overrides,
  };
}

test('settingsOpen reports the currently active provider and its profile list, never the api key itself', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    subject.setProviderSettingsController(stubController({
      current: () => ({ name: 'Qwen VM', baseUrl: 'https://qwen.example/v1', model: 'qwen-abliterated', hasKey: true }),
      list: () => [{ id: 'qwen-1', name: 'Qwen VM', active: true }],
    }));

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
      settingsRemoved: undefined,
      settingsProfiles: [{ id: 'qwen-1', name: 'Qwen VM', active: true }],
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
    subject.setProviderSettingsController(stubController({
      save: async (input: ProviderSettingsInput) => { saved.push(input); },
    }));

    await subject.handleFromWebview({
      type: 'settingsSaveProvider',
      providerName: 'Qwen VM', providerBaseUrl: 'https://qwen.example/v1',
      providerModel: 'qwen-abliterated', providerApiKey: 'sk-secret',
    });

    assert.deepEqual(saved, [{
      id: undefined, name: 'Qwen VM', baseUrl: 'https://qwen.example/v1', model: 'qwen-abliterated',
      apiKey: 'sk-secret', allowInsecureHttp: undefined,
    }]);
    const states = posted.filter(m => m.type === 'settingsState');
    assert.equal(states.at(-1)?.settingsSaved, true);
    assert.equal(states.at(-1)?.settingsBusy, false);
  } finally {
    cleanup();
  }
});

test('settingsSaveProvider passes the edited profile\'s id through, so Save overwrites that one and not whichever happens to be active', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    const saved: ProviderSettingsInput[] = [];
    subject.setProviderSettingsController(stubController({
      save: async (input) => { saved.push(input); },
    }));

    await subject.handleFromWebview({
      type: 'settingsSaveProvider', providerId: 'openai-1',
      providerName: 'OpenAI backup', providerBaseUrl: 'https://api.openai.com/v1', providerModel: 'gpt-4o-mini',
    });

    assert.equal(saved[0]?.id, 'openai-1');
    void posted;
  } finally {
    cleanup();
  }
});

test('settingsSaveProvider refuses a blank form without calling save', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let saveCalled = false;
    subject.setProviderSettingsController(stubController({
      save: async () => { saveCalled = true; },
    }));

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
    subject.setProviderSettingsController(stubController({
      save: async () => { throw new Error('The base URL is not a valid URL.'); },
    }));

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
    subject.setProviderSettingsController(stubController({
      save: async () => { saveCalled = true; },
      test: async (input: ProviderSettingsInput) => {
        assert.equal(input.baseUrl, 'https://qwen.example/v1');
        return { ok: false, summary: 'FAIL  reach: could not connect' };
      },
    }));

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

test('settingsSelectProvider switches the active profile and loads its fields', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let selectedId: string | undefined;
    subject.setProviderSettingsController(stubController({
      select: async (id) => {
        selectedId = id;
        return { name: 'OpenAI backup', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasKey: true };
      },
      list: () => [
        { id: 'qwen-1', name: 'Qwen VM', active: selectedId === 'qwen-1' || selectedId === undefined },
        { id: 'openai-1', name: 'OpenAI backup', active: selectedId === 'openai-1' },
      ],
    }));

    await subject.handleFromWebview({ type: 'settingsSelectProvider', providerId: 'openai-1' });

    assert.equal(selectedId, 'openai-1');
    const final = posted.filter(m => m.type === 'settingsState').at(-1);
    assert.equal(final?.settingsProviderName, 'OpenAI backup');
    assert.equal(final?.settingsProviderModel, 'gpt-4o-mini');
  } finally {
    cleanup();
  }
});

test('settingsRemoveProvider removes the profile and reports it, falling back to whatever is active afterwards', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    let removedId: string | undefined;
    subject.setProviderSettingsController(stubController({
      remove: async (id) => { removedId = id; },
      current: () => (removedId ? undefined : { name: 'OpenAI backup', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', hasKey: true }),
      list: () => (removedId ? [] : [{ id: 'openai-1', name: 'OpenAI backup', active: true }]),
    }));

    await subject.handleFromWebview({ type: 'settingsRemoveProvider', providerId: 'openai-1' });

    assert.equal(removedId, 'openai-1');
    const final = posted.filter(m => m.type === 'settingsState').at(-1);
    assert.equal(final?.settingsRemoved, true);
    assert.equal(final?.settingsProviderName, '');
    assert.deepEqual(final?.settingsProfiles, []);
  } finally {
    cleanup();
  }
});

test('settings messages are no-ops before any controller is set', async () => {
  const { subject, posted, cleanup } = makeProvider();
  try {
    await subject.handleFromWebview({ type: 'settingsOpen' });
    await subject.handleFromWebview({ type: 'settingsSaveProvider', providerName: 'x', providerBaseUrl: 'https://x', providerModel: 'x' });
    await subject.handleFromWebview({ type: 'settingsTestProvider', providerName: 'x', providerBaseUrl: 'https://x', providerModel: 'x' });
    await subject.handleFromWebview({ type: 'settingsSelectProvider', providerId: 'x' });
    await subject.handleFromWebview({ type: 'settingsRemoveProvider', providerId: 'x' });
    assert.deepEqual(posted.filter(m => m.type === 'settingsState'), []);
  } finally {
    cleanup();
  }
});
