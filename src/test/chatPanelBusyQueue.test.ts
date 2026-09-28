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
const vscodeWindow = {
  activeTextEditor: undefined as unknown,
  tabGroups: { all: [] },
  showInputBox: async (): Promise<string | undefined> => undefined,
  showWarningMessage: async (
    _message: string,
    _options?: unknown,
    ..._items: string[]
  ): Promise<string | undefined> => undefined,
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
      window: vscodeWindow,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

// Load after installing the runtime stub: VS Code's API is only present inside
// the Extension Host, while this regression exercises host-side queue policy.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ChatPanelProvider } = require('../chatPanel') as typeof import('../chatPanel');
moduleLoader._load = originalLoad;

class BindingRaceClient {
  notificationHandler: ((method: string, params: unknown) => void) | null = null;
  incomingRequestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  sessionNewResolve: (() => void) | null = null;
  sessionLoadResolve: (() => void) | null = null;
  holdSessionNew = true;
  calls: Array<{ method: string; params: unknown }> = [];
  notifications: Array<{ method: string; params: unknown }> = [];

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  onIncomingRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.incomingRequestHandler = handler;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === 'session/new') {
      if (this.holdSessionNew) {
        await new Promise<void>(resolve => { this.sessionNewResolve = resolve; });
      }
      return { sessionId: 'binding-session' };
    }
    if (method === 'session/load') {
      await new Promise<void>(resolve => { this.sessionLoadResolve = resolve; });
      return {};
    }
    return {};
  }

  notify(method: string, params: unknown): void {
    this.notifications.push({ method, params });
  }
}

test('Stop during first-session binding cancels that turn before queued work starts', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-binding-cancel-'));
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const client = new BindingRaceClient();
  const session = new SessionManager(client as never);

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = () => {};

    await subject.handleFromWebview({ type: 'send', text: 'Cancel while binding', requestId: 'active' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls.map(call => call.method), ['session/new']);

    await subject.handleFromWebview({ type: 'send', text: 'Run after cancellation', requestId: 'queued' });
    await subject.handleFromWebview({ type: 'cancel' });
    client.sessionNewResolve?.();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const promptTexts = client.calls
      .filter(call => call.method === 'session/prompt')
      .map(call => ((call.params as { prompt: Array<{ text: string }> }).prompt[0].text));
    assert.deepEqual(
      promptTexts,
      ['Run after cancellation'],
      'Stop during binding must cancel the owned turn instead of being reset before session/prompt',
    );
    const storedSessions = state.get('hermesRangelTech.sessions') as Array<{ acpSessionId?: string }>;
    assert.equal(storedSessions[0].acpSessionId, 'binding-session');
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Stop during stored-session loading cancels that turn before queued work starts', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-load-cancel-'));
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const client = new BindingRaceClient();
  const session = new SessionManager(client as never);
  session.setStoredSessionId('stored-session');

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = () => {};

    await subject.handleFromWebview({ type: 'send', text: 'Cancel while loading', requestId: 'active-load' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.calls.map(call => call.method), ['session/load']);

    await subject.handleFromWebview({ type: 'send', text: 'Run after load cancellation', requestId: 'queued-load' });
    await subject.handleFromWebview({ type: 'cancel' });
    client.sessionLoadResolve?.();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    const promptTexts = client.calls
      .filter(call => call.method === 'session/prompt')
      .map(call => ((call.params as { prompt: Array<{ text: string }> }).prompt[0].text));
    assert.deepEqual(
      promptTexts,
      ['Run after load cancellation'],
      'Stop during session/load must cancel the owned turn instead of starting its session/prompt',
    );
    assert.equal(
      client.notifications.some(notification => notification.method === 'session/cancel'),
      false,
      'binding-only Stop must not cancel a session that has no active session/prompt',
    );
    const storedSessions = state.get('hermesRangelTech.sessions') as Array<{ acpSessionId?: string }>;
    assert.equal(storedSessions[0].acpSessionId, 'stored-session');
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('reconnects ACP before starting a prompt after the client has stopped', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-prompt-reconnect-'));
  const state = new Map<string, unknown>();
  const events: string[] = [];
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const session = {
    getSessionId: (): string => 'acp-session',
    sendPrompt: async (
      _text: string,
      _cwd: string,
      onSessionBound?: (sessionId: string) => void,
      beforeSessionBinding?: () => Promise<void>,
    ): Promise<void> => {
      events.push('owned');
      await beforeSessionBinding?.();
      onSessionBound?.('acp-session');
      events.push('prompt');
    },
  };
  const profileController = {
    currentProfile: (): string => '',
    profileItems: (): [] => [],
    restartRequired: (): boolean => false,
    selectProfile: async (): Promise<boolean> => false,
    customProfile: async (): Promise<boolean> => false,
    restartHermes: async (): Promise<void> => undefined,
    ensureConnected: async (): Promise<void> => { events.push('connect'); },
  };

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
      () => {},
      profileController,
    );
    const subject = provider as unknown as {
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = () => {};

    await subject.handleFromWebview({ type: 'send', text: 'Resume safely', requestId: 'reconnect' });
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(events, ['owned', 'connect', 'prompt']);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('Stop while reconnect is pending prevents that prompt from starting', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-reconnect-cancel-'));
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const client = new BindingRaceClient();
  const session = new SessionManager(client as never);
  let announceReconnect: () => void = () => {};
  let releaseReconnect: () => void = () => {};
  const reconnectStarted = new Promise<void>(resolve => { announceReconnect = resolve; });
  const profileController = {
    currentProfile: (): string => '',
    profileItems: (): [] => [],
    restartRequired: (): boolean => false,
    selectProfile: async (): Promise<boolean> => false,
    customProfile: async (): Promise<boolean> => false,
    restartHermes: async (): Promise<void> => undefined,
    ensureConnected: async (): Promise<void> => {
      announceReconnect();
      await new Promise<void>(resolve => { releaseReconnect = resolve; });
    },
  };

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session,
      'test-model',
      'test-version',
      context as never,
      () => {},
      profileController,
    );
    const subject = provider as unknown as {
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = () => {};

    await subject.handleFromWebview({ type: 'send', text: 'Do not start', requestId: 'cancel-reconnect' });
    await reconnectStarted;
    await subject.handleFromWebview({ type: 'cancel' });
    releaseReconnect();
    await new Promise(resolve => setImmediate(resolve));
    client.sessionNewResolve?.();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(
      client.calls.some(call => call.method === 'session/prompt'),
      false,
      'a stopped reconnecting turn must not reach session/prompt after reconnect resolves',
    );
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('queues a follow-up submitted while busy without cancelling the active prompt', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-busy-queue-'));
  let cancelCalls = 0;
  let activePromptCalls = 0;
  let maxActivePromptCalls = 0;
  const prompts: string[] = [];
  const promptResolvers: Array<() => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const session = {
    cancel: async (): Promise<void> => { cancelCalls += 1; },
    ensureSession: async (): Promise<string> => 'acp-session',
    getSessionId: (): string => 'acp-session',
    sendPrompt: async (text: string): Promise<void> => {
      prompts.push(text);
      activePromptCalls += 1;
      maxActivePromptCalls = Math.max(maxActivePromptCalls, activePromptCalls);
      await new Promise<void>((resolve) => { promptResolvers.push(resolve); });
      activePromptCalls -= 1;
    },
  };

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      busy: boolean;
      lastTurnText: string;
      messageQueue: Array<{
        text: string;
        requestId?: string;
        attachedFiles: Array<{ name: string; path: string }>;
        selectedSkills: string[];
        ideContext: string;
      }>;
      attachedFiles: Array<{ name: string; path: string }>;
      selectedSkills: string[];
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      saveTurnToSession(): void;
      capturePromptRequest(text: string): {
        text: string;
        isSlashCommand: boolean;
        attachedFiles: Array<{ name: string; path: string }>;
        selectedSkills: string[];
        ideContext: string;
      };
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = (message) => { posted.push(message); };

    await subject.handleFromWebview({ type: 'send', text: 'Start the long task', requestId: 'active-1' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(prompts, ['Start the long task']);
    assert.deepEqual(posted.find(message => message.startedRequestId === 'active-1'), {
      type: 'busy',
      active: true,
      queued: 0,
      queuedItems: [],
      startedText: 'Start the long task',
      startedSlashCommand: false,
      startedRequestId: 'active-1',
    }, 'the host must authoritatively confirm even an immediately started composer request');

    await subject.handleFromWebview({ type: 'newSession' });
    assert.deepEqual(posted.at(-1), {
      type: 'notice',
      text: 'Stop or finish the active Hermes turn before changing sessions or profiles.',
    }, 'session lifecycle changes must not rebind while a prompt owns the active session');

    vscodeWindow.activeTextEditor = {
      document: { uri: { fsPath: '/workspace/first.ts' } },
      selection: { isEmpty: true },
    };
    subject.attachedFiles = [{ name: 'first.md', path: '/context/first.md' }];
    subject.selectedSkills = ['first-skill'];
    await subject.handleFromWebview({
      type: 'send', text: 'Use the safer approach instead', requestId: 'queued-1',
    });

    vscodeWindow.activeTextEditor = {
      document: { uri: { fsPath: '/workspace/second.ts' } },
      selection: { isEmpty: true },
    };
    subject.attachedFiles = [{ name: 'second.md', path: '/context/second.md' }];
    subject.selectedSkills = ['second-skill'];
    await subject.handleFromWebview({
      type: 'send', text: 'Then verify the result', requestId: 'queued-2',
    });

    assert.equal(cancelCalls, 0, 'a normal follow-up must not hard-cancel the active ACP request');
    assert.deepEqual(subject.messageQueue.map(item => ({
      text: item.text,
      requestId: item.requestId,
      files: item.attachedFiles.map(file => file.path),
      skills: item.selectedSkills,
      ideContext: item.ideContext,
    })), [
      {
        text: 'Use the safer approach instead',
        requestId: 'queued-1',
        files: ['/context/first.md'],
        skills: ['first-skill'],
        ideContext: '[Active file: /workspace/first.ts]\n\n',
      },
      {
        text: 'Then verify the result',
        requestId: 'queued-2',
        files: ['/context/second.md'],
        skills: ['second-skill'],
        ideContext: '[Active file: /workspace/second.ts]\n\n',
      },
    ]);
    assert.deepEqual(subject.attachedFiles, []);
    assert.deepEqual(subject.selectedSkills, []);
    assert.deepEqual(posted.at(-1), {
      type: 'busy',
      active: true,
      queued: 2,
      queuedItems: [
        { requestId: 'queued-1', text: 'Use the safer approach instead', isSlashCommand: false },
        { requestId: 'queued-2', text: 'Then verify the result', isSlashCommand: false },
      ],
    });

    const readyMessageStart = posted.length;
    await subject.handleFromWebview({ type: 'ready' });
    const readyMessages = posted.slice(readyMessageStart);
    const readyHistoryIndex = readyMessages.findIndex(message => message.type === 'loadHistory');
    const readyQueueIndex = readyMessages.findIndex(message => message.type === 'queueState');
    assert.ok(
      readyHistoryIndex >= 0 && readyQueueIndex > readyHistoryIndex,
      'history must load before queue hydration enables live start rendering',
    );
    assert.equal(
      readyMessages.at(-1)?.type,
      'queueState',
      'runtime hydration must finish before the final ready handshake enables submissions',
    );
    assert.deepEqual(
      posted.filter(message => message.type === 'queueState').at(-1),
      {
        type: 'queueState',
        active: true,
        queued: 2,
        activeSlashCommand: false,
        queuedItems: [
          { requestId: 'queued-1', text: 'Use the safer approach instead', isSlashCommand: false },
          { requestId: 'queued-2', text: 'Then verify the result', isSlashCommand: false },
        ],
      },
      'a recreated webview must inherit the live host queue state',
    );
    assert.deepEqual(
      (state.get('hermesRangelTech.sessions') as Array<{ messages: Array<{ role: string; text: string }> }>)[0].messages,
      [{ role: 'user', text: 'Start the long task' }],
      'queued input must not be persisted ahead of the active turn response',
    );

    subject.lastTurnText = 'First answer';
    subject.saveTurnToSession();
    promptResolvers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    const startedFirstQueued = posted.find(message =>
      message.type === 'busy' && message.startedText === 'Use the safer approach instead',
    );
    assert.deepEqual(startedFirstQueued, {
      type: 'busy',
      active: true,
      queued: 1,
      startedText: 'Use the safer approach instead',
      startedSlashCommand: false,
      startedRequestId: 'queued-1',
      queuedItems: [
        { requestId: 'queued-2', text: 'Then verify the result', isSlashCommand: false },
      ],
    });
    assert.equal(
      posted.filter(message => message.startedRequestId === 'queued-1').length,
      1,
      'handoff must emit exactly one authoritative start confirmation',
    );
    const queuedStartIndex = posted.findIndex(message => message.startedRequestId === 'queued-1');
    const queuedAnnotationIndex = posted.findIndex((message, index) =>
      index > queuedStartIndex
      && message.type === 'statusBar'
      && typeof message.contextAnnotation === 'string'
      && message.contextAnnotation.includes('first.md'),
    );
    assert.ok(
      queuedAnnotationIndex > queuedStartIndex,
      'context annotation must follow the start acknowledgement that renders its user bubble',
    );
    assert.deepEqual(
      prompts.map(prompt => prompt.includes('Use the safer approach instead')
        ? 'first queued'
        : prompt.includes('Then verify the result') ? 'second queued' : prompt),
      ['Start the long task', 'first queued'],
      'the follow-up must start after the active prompt reaches its terminal response',
    );
    assert.match(prompts[1], /I advise you to use the following skills: first-skill/);
    assert.match(prompts[1], /\[Referenced file: \/context\/first\.md\]/);
    assert.match(prompts[1], /\[Active file: \/workspace\/first\.ts\]/);
    assert.doesNotMatch(prompts[1], /second-skill|second\.md|second\.ts/);
    assert.deepEqual(
      (state.get('hermesRangelTech.sessions') as Array<{ messages: Array<{ role: string; text: string }> }>)[0].messages,
      [
        { role: 'user', text: 'Start the long task' },
        { role: 'agent', text: 'First answer' },
        { role: 'user', text: 'Use the safer approach instead' },
      ],
    );
    promptResolvers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(prompts.length, 3);
    assert.match(prompts[2], /Then verify the result/);
    assert.match(prompts[2], /I advise you to use the following skills: second-skill/);
    assert.match(prompts[2], /\[Referenced file: \/context\/second\.md\]/);
    assert.match(prompts[2], /\[Active file: \/workspace\/second\.ts\]/);
    assert.doesNotMatch(prompts[2], /first-skill|first\.md|first\.ts/);
    promptResolvers.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(subject.busy, false);
    assert.equal(maxActivePromptCalls, 1, 'prompt-producing actions must remain serialized');

    subject.attachedFiles = [{ name: 'unused.md', path: '/context/unused.md' }];
    subject.selectedSkills = ['unused-skill'];
    assert.deepEqual(subject.capturePromptRequest('/queue verify after completion'), {
      text: '/queue verify after completion',
      isSlashCommand: true,
      attachedFiles: [],
      selectedSkills: [],
      ideContext: '',
    });
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('queues model changes and keeps local title changes out of ACP while busy', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-busy-actions-'));
  let cancelCalls = 0;
  let activePromptCalls = 0;
  let maxActivePromptCalls = 0;
  const prompts: string[] = [];
  const posted: Record<string, unknown>[] = [];
  const promptResolvers: Array<() => void> = [];
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const session = {
    cancel: async (): Promise<void> => { cancelCalls += 1; },
    ensureSession: async (): Promise<string> => 'acp-session',
    getSessionId: (): string => 'acp-session',
    sendPrompt: async (text: string): Promise<void> => {
      prompts.push(text);
      activePromptCalls += 1;
      maxActivePromptCalls = Math.max(maxActivePromptCalls, activePromptCalls);
      await new Promise<void>(resolve => { promptResolvers.push(resolve); });
      activePromptCalls -= 1;
    },
  };

  try {
    vscodeWindow.activeTextEditor = undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      messageQueue: Array<{ text: string }>;
      store: {
        ensureSession(): void;
        activeId: string | undefined;
      };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = message => { posted.push(message); };
    vscodeWindow.showInputBox = async () => 'Renamed while busy';

    await subject.handleFromWebview({
      type: 'send',
      text: 'Run the active task',
      requestId: 'active-1',
    });
    await new Promise(resolve => setImmediate(resolve));
    await subject.handleFromWebview({ type: 'switchModel', model: 'next-model' });
    await subject.handleFromWebview({
      type: 'renameSession',
      sessionId: subject.store.activeId,
    });
    await subject.handleFromWebview({ type: 'cancel' });

    assert.equal(cancelCalls, 1, 'only the explicit Stop message should cancel');
    assert.deepEqual(subject.messageQueue.map(item => item.text), [
      '/model next-model',
    ]);
    assert.deepEqual(prompts, ['Run the active task']);

    promptResolvers.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prompts, ['Run the active task', '/model next-model']);
    promptResolvers.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prompts, ['Run the active task', '/model next-model']);
    assert.equal(maxActivePromptCalls, 1);

    await subject.handleFromWebview({ type: 'switchModel', model: 'idle-model' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prompts, ['Run the active task', '/model next-model', '/model idle-model']);
    assert.equal(maxActivePromptCalls, 1);
    assert.ok(posted.some(message =>
      message.type === 'busy'
      && message.startedText === '/model idle-model'
      && message.startedSlashCommand === true
      && message.startedRequestId === undefined
    ), 'an idle host-only command should announce its slash-response semantics');
    await subject.handleFromWebview({ type: 'ready' });
    assert.deepEqual(
      posted.filter(message => message.type === 'queueState').at(-1),
      { type: 'queueState', active: true, queued: 0, activeSlashCommand: true, queuedItems: [] },
      'a recreated webview must preserve the active slash-response styling',
    );
    promptResolvers.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('edits and deletes composer-owned queue entries before handoff', async () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-queue-mutations-'));
  const prompts: string[] = [];
  const promptResolvers: Array<() => void> = [];
  const posted: Array<Record<string, unknown>> = [];
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const session = {
    cancel: async (): Promise<void> => undefined,
    ensureSession: async (): Promise<string> => 'acp-session',
    getSessionId: (): string => 'acp-session',
    sendPrompt: async (text: string): Promise<void> => {
      prompts.push(text);
      await new Promise<void>(resolve => { promptResolvers.push(resolve); });
    },
  };

  try {
    vscodeWindow.activeTextEditor = undefined;
    vscodeWindow.showWarningMessage = async () => undefined;
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      messageQueue: Array<{
        text: string;
        requestId?: string;
        isSlashCommand: boolean;
        attachedFiles: Array<{ name: string; path: string }>;
        selectedSkills: string[];
        ideContext: string;
      }>;
      attachedFiles: Array<{ name: string; path: string }>;
      selectedSkills: string[];
      store: { ensureSession(): void };
      post(message: Record<string, unknown>): void;
      handleFromWebview(message: Record<string, unknown>): Promise<void>;
    };
    subject.store.ensureSession();
    subject.post = message => { posted.push(message); };

    await subject.handleFromWebview({ type: 'send', text: 'Active task', requestId: 'active' });
    await new Promise(resolve => setImmediate(resolve));

    vscodeWindow.activeTextEditor = {
      document: { uri: { fsPath: '/workspace/original.ts' } },
      selection: { isEmpty: true },
    };
    subject.attachedFiles = [{ name: 'context.md', path: '/context/context.md' }];
    subject.selectedSkills = ['queue-skill'];
    await subject.handleFromWebview({ type: 'send', text: 'Original queued text', requestId: 'queued-1' });
    await subject.handleFromWebview({ type: 'send', text: 'Delete this queued text', requestId: 'queued-2' });

    await subject.handleFromWebview({
      type: 'editQueuedMessage', requestId: 'queued-1', text: 'Revised queued text',
    });
    assert.equal(subject.messageQueue[0].text, 'Revised queued text');
    assert.deepEqual(subject.messageQueue[0].attachedFiles, [
      { name: 'context.md', path: '/context/context.md' },
    ], 'a prose edit must retain the context captured when it was submitted');
    assert.deepEqual(subject.messageQueue[0].selectedSkills, ['queue-skill']);
    assert.equal(subject.messageQueue[0].ideContext, '[Active file: /workspace/original.ts]\n\n');

    await subject.handleFromWebview({
      type: 'editQueuedMessage', requestId: 'queued-1', text: '/queue revised instruction',
    });
    assert.equal(subject.messageQueue[0].isSlashCommand, true);
    assert.deepEqual(subject.messageQueue[0].attachedFiles, []);
    assert.deepEqual(subject.messageQueue[0].selectedSkills, []);
    assert.equal(subject.messageQueue[0].ideContext, '');

    await subject.handleFromWebview({
      type: 'editQueuedMessage', requestId: 'queued-1', text: '   ',
    });
    assert.equal(subject.messageQueue[0].text, '/queue revised instruction', 'an empty edit must be ignored');

    await subject.handleFromWebview({ type: 'deleteQueuedMessage', requestId: 'queued-2' });
    assert.deepEqual(
      subject.messageQueue.map(item => item.requestId),
      ['queued-1', 'queued-2'],
      'dismissing the supported VS Code confirmation must retain the queued message',
    );

    vscodeWindow.showWarningMessage = async () => 'Delete';
    await subject.handleFromWebview({ type: 'deleteQueuedMessage', requestId: 'queued-2' });
    assert.deepEqual(subject.messageQueue.map(item => item.requestId), ['queued-1']);
    assert.deepEqual(posted.filter(message => message.type === 'queueState').at(-1), {
      type: 'queueState',
      active: true,
      queued: 1,
      activeSlashCommand: false,
      queuedItems: [
        { requestId: 'queued-1', text: '/queue revised instruction', isSlashCommand: true },
      ],
    });

    promptResolvers.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(prompts, ['Active task', '/queue revised instruction']);
    assert.ok(posted.some(message =>
      message.type === 'busy'
      && message.startedRequestId === 'queued-1'
      && message.startedText === '/queue revised instruction'
      && message.startedSlashCommand === true
    ));
    promptResolvers.shift()?.();
    await new Promise(resolve => setImmediate(resolve));
  } finally {
    vscodeWindow.showWarningMessage = async () => undefined;
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('keeps the composer busy and persists one continuous autonomous Lead turn', () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-autonomous-turn-'));
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const posted: Array<Record<string, unknown>> = [];
  const session = { getSessionId: (): string => 'acp-session' };

  try {
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      busy: boolean;
      autonomousTurnId?: string;
      lastTurnText: string;
      backgroundMessages: { push(sessionId: string, text: string, id: string): void };
      store: {
        ensureSession(): void;
        setAcpSessionId(id: string): void;
        active(): { messages: Array<{ role: string; text: string }> } | undefined;
      };
      post(message: Record<string, unknown>): void;
      handleAutonomousTurn(event: Record<string, unknown>): void;
    };
    subject.store.ensureSession();
    subject.store.setAcpSessionId('acp-session');
    subject.post = message => { posted.push(message); };
    subject.handleAutonomousTurn({
      session_id: 'other-session',
      autonomousTurn: { id: 'proc_other', status: 'running', trigger: 'background_notification' },
    });
    assert.equal(subject.busy, false, 'inactive ACP sessions must not seize the active composer');
    assert.equal(subject.autonomousTurnId, undefined);
    subject.backgroundMessages.push(
      'acp-session', '[Background process proc_tv completed]', 'proc_tv',
    );

    subject.handleAutonomousTurn({
      session_id: 'acp-session',
      autonomousTurn: { id: 'proc_tv', status: 'running', trigger: 'background_notification' },
    });
    assert.equal(subject.busy, true);
    assert.equal(subject.autonomousTurnId, 'proc_tv');
    assert.equal(subject.store.active()?.messages.at(-1)?.role, 'agent');
    assert.equal(subject.store.active()?.messages.at(-1)?.text,
      '[Background process proc_tv completed]');
    assert.equal(posted.at(-1)?.type, 'busy');
    assert.equal(posted.at(-1)?.active, true);

    subject.lastTurnText = 'The Technical Validator passed; continuing implementation.';
    subject.handleAutonomousTurn({
      session_id: 'acp-session',
      autonomousTurn: { id: 'proc_tv', status: 'completed', trigger: 'background_notification' },
    });

    assert.equal(subject.busy, false);
    assert.equal(subject.autonomousTurnId, undefined);
    assert.equal(subject.store.active()?.messages.at(-1)?.text,
      'The Technical Validator passed; continuing implementation.');
    assert.deepEqual(posted.slice(-2), [
      { type: 'done' },
      { type: 'busy', active: false, queued: 0, queuedItems: [] },
    ]);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('persists an inactive session autonomous Lead response without seizing the visible composer', () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-inactive-autonomous-turn-'));
  const state = new Map<string, unknown>();
  state.set('hermesRangelTech.sessions', [
    {
      id: 'old-chat', title: 'Old Lead chat', createdAt: 1, messages: [],
      acpSessionId: 'old-acp-session',
    },
    {
      id: 'visible-chat', title: 'Visible chat', createdAt: 2, messages: [],
      acpSessionId: 'visible-acp-session',
    },
  ]);
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  const posted: Array<Record<string, unknown>> = [];
  const session = { getSessionId: (): string => 'visible-acp-session' };

  try {
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      busy: boolean;
      post(message: Record<string, unknown>): void;
      captureAutonomousEvent(event: Record<string, unknown>): boolean;
      handleAutonomousTurn(event: Record<string, unknown>): void;
      store: {
        allSessions(): Array<{ id: string; messages: Array<{ role: string; text: string }> }>;
      };
    };
    subject.post = message => { posted.push(message); };

    subject.handleAutonomousTurn({
      session_id: 'old-acp-session',
      autonomousTurn: {
        id: 'old-turn', status: 'running', trigger: 'background_notification',
      },
    });
    assert.equal(subject.captureAutonomousEvent({
      session_id: 'old-acp-session',
      autonomousTurnId: 'old-turn',
      text: 'The old Lead consumed the role result and completed its next step.',
    }), true, 'inactive output must be consumed without rendering in the visible chat');
    assert.equal(subject.captureAutonomousEvent({
      session_id: 'old-acp-session',
      autonomousTurnId: 'old-turn',
      toolTitle: 'write_file',
      toolStatus: 'completed',
      toolDetail: 'saved old-chat output',
    }), true, 'inactive tool updates must stay on the owning hidden chat');
    subject.handleAutonomousTurn({
      session_id: 'old-acp-session',
      autonomousTurn: {
        id: 'old-turn', status: 'completed', trigger: 'background_notification',
      },
    });

    const oldChat = subject.store.allSessions().find(chat => chat.id === 'old-chat');
    const visibleChat = subject.store.allSessions().find(chat => chat.id === 'visible-chat');
    assert.equal(oldChat?.messages.at(-2)?.text, '✓ write_file: saved old-chat output');
    assert.equal(oldChat?.messages.at(-1)?.text,
      'The old Lead consumed the role result and completed its next step.');
    assert.deepEqual(visibleChat?.messages, []);
    assert.equal(subject.busy, false);
    assert.equal(posted.some(message => message.type === 'busy' || message.type === 'done'), false);
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('keeps Lead and canonical role chips while scoping delegated chips to the owning session generation', () => {
  const storageRoot = mkdtempSync(join(tmpdir(), 'hermes-vscode-delegation-activity-'));
  const state = new Map<string, unknown>();
  const context = {
    globalStorageUri: { fsPath: storageRoot },
    workspaceState: {
      get: <T>(key: string): T | undefined => state.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
    },
  };
  let generation = 7;
  const session = { getRuntimeGeneration: (): number => generation };

  try {
    const provider = new ChatPanelProvider(
      { fsPath: '/extension' } as never,
      session as never,
      'test-model',
      'test-version',
      context as never,
    );
    const subject = provider as unknown as {
      agentActivitiesBySession: Map<string, Array<{ id: string; name: string; status: string }>>;
      workspaceRoleActivities: Array<{ id: string; name: string; status: string }>;
      sessionDelegationActivities: Array<{ id: string; name: string; status: string }>;
      sessionDelegationScope?: { sessionId: string; generation: number };
      agentActivitiesFor(sessionId?: string): Array<{ id: string }>;
    };
    subject.agentActivitiesBySession.set('session-a', [
      { id: 'primary', name: 'Lead / PM', status: 'idle' },
    ]);
    subject.workspaceRoleActivities = [
      { id: 'role-run:validator', name: 'Technical Validator', status: 'running' },
    ];
    subject.sessionDelegationScope = { sessionId: 'session-a', generation: 7 };
    subject.sessionDelegationActivities = [
      { id: 'delegate-task:deleg_abcdef12:0', name: 'Delegate · Inspect candidate', status: 'running' },
    ];

    assert.deepEqual(subject.agentActivitiesFor('session-a').map(item => item.id), [
      'primary',
      'role-run:validator',
      'delegate-task:deleg_abcdef12:0',
    ]);
    assert.deepEqual(subject.agentActivitiesFor('session-b').map(item => item.id), [
      'role-run:validator',
    ], 'foreign sessions must not receive delegated activity');

    generation = 8;
    assert.deepEqual(subject.agentActivitiesFor('session-a').map(item => item.id), [
      'primary',
      'role-run:validator',
    ], 'a replaced ACP generation must hide delayed delegated activity without changing other chips');
  } finally {
    rmSync(storageRoot, { recursive: true, force: true });
  }
});
