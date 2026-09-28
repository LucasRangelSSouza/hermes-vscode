/**
 * ChatPanel — the VS Code WebviewView provider.
 * Renders the chat UI and bridges messages between the webview and SessionManager.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SessionManager } from './sessionManager';
import { SessionStore } from './sessionStore';
import { loadHermesModelGroups, ModelMenuGroup } from './modelCatalog';
import { loadHermesSkills, SkillGroup } from './skillCatalog';
import { buildChatHtml, escapeHtml } from './htmlTemplate';
import { profileDisplayName } from './profileUi';
import { BackgroundMessageAccumulator, routeBackgroundMessage } from './backgroundMessageAccumulator';
import { sendPromptWithSessionBinding } from './promptSessionBinding';
import { sessionReadyUiMessages, sessionSwitchUiMessages } from './sessionSwitchUi';
import type { SessionContextUsage } from './sessionSwitchUi';
import { DEFAULT_AVAILABLE_COMMANDS, isKnownSlashCommand } from './slashCommands';
import { normalizePastedImageExtension } from './pastedImage';
import { deleteQueuedMessage, editQueuedMessage, editableQueuedMessages } from './webviewQueue';
import type { ProfileMenuItem } from './profileUi';
import type { AttachedFile, BackgroundProcessState, SessionUpdateEvent, StoredMessage, ToWebview, FromWebview } from './types';
import type { AgentActivity } from './agentActivity';
import type { AvailableSlashCommand } from './slashCommands';
import { defaultRoleRunsRoot, RoleRunMonitor } from './roleRunMonitor';
import {
  defaultHermesHome,
  DelegationActivityMonitor,
  DelegationRegistrationStore,
  resolveHermesHomeForProfile,
} from './delegationActivityMonitor';

interface PromptRequest {
  text: string;
  requestId?: string;
  isSlashCommand: boolean;
  attachedFiles: AttachedFile[];
  selectedSkills: string[];
  ideContext: string;
}

export interface ProfileController {
  currentProfile(): string;
  profileItems(): ProfileMenuItem[];
  restartRequired(): boolean;
  selectProfile(profile: string): Promise<boolean>;
  customProfile(): Promise<boolean>;
  restartHermes(): Promise<void>;
  ensureConnected?(): Promise<void>;
}

export class ChatPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = 'hermesRangelTech.chatView';

  private view?: vscode.WebviewView;
  private busy = false;
  private activeRequest?: PromptRequest;
  private autonomousTurnId?: string;
  private readonly autonomousTurnsBySession = new Map<string, { id: string; text: string; tools: StoredMessage[] }>();
  private messageQueue: PromptRequest[] = [];
  private lastTurnText = '';
  private lastTurnTools: StoredMessage[] = [];
  private readonly backgroundProcessesBySession = new Map<string, Map<string, BackgroundProcessState>>();
  private readonly agentActivitiesBySession = new Map<string, AgentActivity[]>();
  private workspaceRoleActivities: AgentActivity[] = [];
  private sessionDelegationActivities: AgentActivity[] = [];
  private sessionDelegationScope?: { sessionId: string; generation: number };
  private readonly availableCommandsBySession = new Map<string, AvailableSlashCommand[]>();
  private readonly contextUsageBySession = new Map<string, SessionContextUsage>();
  private readonly backgroundMessages: BackgroundMessageAccumulator;
  private readonly roleRunMonitor: RoleRunMonitor;
  private readonly delegationRegistrationStore = new DelegationRegistrationStore();
  private readonly delegationActivityMonitor: DelegationActivityMonitor;
  private runtimeHydration: Promise<void> | undefined;
  private lifecycleTransition: Promise<void> | undefined;

  private readonly store: SessionStore;
  private readonly modelGroups: ModelMenuGroup[] = loadHermesModelGroups();
  private readonly skillGroups: SkillGroup[] = loadHermesSkills();

  private selectedSkills: string[] = [];
  private attachedFiles: { name: string; path: string }[] = [];
  private toolCallLocations = new Map<string, { kind: string; paths: string[] }>();
  private readonly mediaRoot: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly session: SessionManager,
    private readonly initialModel: string = '—',
    private readonly hermesVersion: string = '',
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void = () => {},
    private readonly profileController?: ProfileController,
  ) {
    this.mediaRoot = path.join(this.context.globalStorageUri.fsPath, 'media');
    fs.mkdirSync(this.mediaRoot, { recursive: true });
    this.store = new SessionStore(context);
    this.backgroundMessages = new BackgroundMessageAccumulator((sessionId, text) => {
      this.flushBackgroundMessage(sessionId, text);
    });
    this.roleRunMonitor = new RoleRunMonitor(
      defaultRoleRunsRoot(),
      () => {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!workspaceRoot) return undefined;
        return { scopeId: `workspace:${workspaceRoot}`, workspaceRoot };
      },
      (scope, activities) => {
        if (!scope.scopeId) return;
        this.workspaceRoleActivities = activities.map(activity => ({ ...activity }));
        this.post({
          type: 'statusBar',
          agentActivities: this.agentActivitiesFor(this.store.getAcpSessionId()),
        });
      },
    );
    this.delegationActivityMonitor = new DelegationActivityMonitor(
      () => resolveHermesHomeForProfile(
        this.profileController?.currentProfile(),
        defaultHermesHome(),
      ),
      () => this.delegationRegistrationStore.scope(
        this.session.getSessionId(),
        this.session.getRuntimeGeneration(),
      ),
      (scope, activities) => {
        this.sessionDelegationScope = { sessionId: scope.sessionId, generation: scope.generation };
        this.sessionDelegationActivities = activities.map(activity => ({ ...activity }));
        this.post({
          type: 'statusBar',
          agentActivities: this.agentActivitiesFor(this.store.getAcpSessionId()),
        });
      },
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.extensionUri, 'resources'),
        vscode.Uri.file(this.mediaRoot),
      ],
    };

    // Create first session if none exist
    this.store.ensureSession();
    this.roleRunMonitor.start();
    this.delegationActivityMonitor.start();

    // Restore ACP session ID from persisted state (enables Hermes context resume)
    const active = this.store.active();
    if (active?.acpSessionId) {
      this.session.setStoredSessionId(active.acpSessionId);
      this.log(`[session] will attempt resume of ACP session ${active.acpSessionId}`);
    }

    webviewView.webview.onDidReceiveMessage((msg: FromWebview) => {
      void this.handleFromWebview(msg);
    });
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) this.view = undefined;
      // Keep pending debounce timers alive long enough to persist their owning
      // session. Flushing here would split a delayed response on panel reload.
    });

    // Route session updates to the webview
    this.session.onUpdate((event) => {
      if (!event.replay && event.delegationRegistration && event.runtimeGeneration !== undefined) {
        this.delegationRegistrationStore.register(
          event.session_id,
          event.runtimeGeneration,
          event.delegationRegistration,
        );
        void this.delegationActivityMonitor.refresh();
      }
      if (event.agentActivities !== undefined) {
        this.agentActivitiesBySession.set(event.session_id, event.agentActivities.map(activity => ({ ...activity })));
        if (this.isActiveRuntimeSession(event.session_id)) {
          this.post({ type: 'statusBar', agentActivities: this.agentActivitiesFor(event.session_id) });
        }
      }
      if (event.availableCommands !== undefined) {
        this.availableCommandsBySession.set(event.session_id, event.availableCommands.map(command => ({ ...command })));
        if (this.isActiveRuntimeSession(event.session_id)) {
          this.post({ type: 'statusBar', availableCommands: event.availableCommands });
        }
      }
      if (event.contextUsed !== undefined || event.compressionCount !== undefined) {
        const previous = this.contextUsageBySession.get(event.session_id) ?? {};
        this.contextUsageBySession.set(event.session_id, {
          ...previous,
          ...(event.contextUsed !== undefined ? { contextUsed: event.contextUsed } : {}),
          ...(event.contextSize !== undefined ? { contextSize: event.contextSize } : {}),
          ...(event.cachedTokens !== undefined ? { cachedTokens: event.cachedTokens } : {}),
          ...(event.compressionCount !== undefined ? { compressionCount: event.compressionCount } : {}),
        });
      }
      if (event.sessionTitle && this.store.renameByAcpSessionId(event.session_id, event.sessionTitle)) {
        this.broadcastSessions(this.store);
      }
      if ((event.model || event.sessionTitle || event.contextUsed !== undefined || event.compressionCount !== undefined)
        && this.isActiveRuntimeSession(event.session_id)) {
        this.post({
          type: 'statusBar',
          model: event.model,
          sessionTitle: event.sessionTitle,
          contextUsed: event.contextUsed,
          contextSize: event.contextSize,
          cachedTokens: event.cachedTokens,
          compressionCount: event.compressionCount,
        });
      }
      // The local session store already hydrated the visible transcript. ACP
      // replay remains useful for metadata discovery, but rendering it again
      // would duplicate messages and resurrect historical process state.
      if (event.replay) return;
      if (event.autonomousTurn) {
        this.handleAutonomousTurn(event);
        if (!event.text && !event.thinkingText && event.toolTitle === undefined) return;
      }
      if (event.backgroundProcess) this.updateBackgroundProcess(event.session_id, event.backgroundProcess);
      if (this.captureAutonomousEvent(event)) return;
      if (event.background) {
        // ACP can deliver a delayed response as many token-sized chunks after
        // session/prompt has returned. Coalesce by owning session before one
        // render/persist operation; treating each chunk as a complete message
        // produces one word per block and corrupts restored history.
        if (event.text) {
          const notificationId = event.backgroundProcess?.id ?? event.session_id;
          this.backgroundMessages.push(event.session_id, event.text, notificationId);
        }
        return;
      }
      if (event.text) {
        // Convert MEDIA:/path references to webview-safe img URIs
        const converted = this.convertMediaPaths(event.text, webviewView.webview);
        this.lastTurnText += event.text;
        this.post({ type: 'append', text: converted });
      }
      if (event.thinkingText) {
        this.post({ type: 'thinking', text: event.thinkingText });
      }
      if (event.toolTitle !== undefined) {
        if (event.toolTitle === '' && event.toolCallId) {
          // tool_call_update — status change for existing tool
          this.post({ type: 'toolCall', toolCallId: event.toolCallId, toolStatus: event.toolStatus });

          // Open edited/read files in VS Code editor on completion
          if (event.toolStatus === 'completed' && event.toolCallId) {
            const info = this.toolCallLocations.get(event.toolCallId);
            if (info && info.paths.length > 0 && (info.kind === 'edit' || info.kind === 'read')) {
              for (const filePath of info.paths) {
                this.openFileInEditor(filePath, info.kind === 'edit');
              }
            }
            this.toolCallLocations.delete(event.toolCallId);
          }
        } else if (event.toolTitle) {
          const icon = event.toolStatus === 'done' || event.toolStatus === 'completed' ? '✓' : event.toolStatus === 'error' ? '✗' : '⋯';
          this.lastTurnTools.push({ role: 'tool', text: `${icon} ${event.toolTitle}${event.toolDetail ? ': ' + event.toolDetail : ''}` });
          // Store locations for file-open on completion
          if (event.toolCallId && event.toolLocations?.length && event.toolKind) {
            this.toolCallLocations.set(event.toolCallId, {
              kind: event.toolKind,
              paths: event.toolLocations,
            });
          }
          this.post({
            type: 'toolCall',
            toolName: event.toolTitle,
            toolStatus: event.toolStatus,
            toolCallId: event.toolCallId,
            toolDetail: event.toolDetail,
            toolKind: event.toolKind,
            toolLocations: event.toolLocations,
          });
        }
      }
      // Forward todo state updates to webview
      if (event.todoState) {
        this.post({ type: 'statusBar', todoState: event.todoState });
      }
      if (event.done) {
        // Detect model-switch response and update status bar
        const modelMatch = /model (?:switched|changed) to:\s*([\w\-\.]+)/i.exec(this.lastTurnText);
        if (modelMatch) {
          this.post({ type: 'statusBar', model: modelMatch[1] });
        }
        // Persist ACP session ID so Hermes can resume context
        const acpId = this.session.getSessionId();
        if (acpId) this.store.setAcpSessionId(acpId);
        // Persist the turn into session history
        this.saveTurnToSession();
        this.post({ type: 'done' });
      }
      if (event.error) {
        this.lastTurnText = '';
        this.lastTurnTools = [];
        this.post({ type: 'error', text: event.error });
      }
    });

    // Load the document only after its message and session-update handlers exist.
    webviewView.webview.html = this.buildHtml(webviewView.webview);
  }

  post(msg: ToWebview): void {
    this.view?.webview.postMessage(msg);
  }

  async requestNewSession(): Promise<void> {
    await this.handleFromWebview({ type: 'newSession' });
  }

  /** Injects a remote-control instruction (RIA Atendimento) exactly like a
   * message typed locally: it queues if the panel is busy, runs otherwise,
   * and shows up in the local chat too, so the person in front of this VS
   * Code sees what the remote session asked for. */
  async requestRemotePrompt(text: string): Promise<void> {
    await this.handleFromWebview({ type: 'send', text });
  }

  async requestHermesRestart(): Promise<boolean> {
    await this.handleFromWebview({ type: 'restartHermes' });
    return !this.busy;
  }

  async requestProfileSelection(profile: string): Promise<void> {
    await this.handleFromWebview({ type: 'selectProfile', text: profile });
  }

  private postQueueState(): void {
    this.post({
      type: 'queueState',
      active: this.busy,
      queued: this.messageQueue.length,
      activeSlashCommand: this.activeRequest?.isSlashCommand ?? false,
      queuedItems: editableQueuedMessages(this.messageQueue),
    });
  }

  private emitInitialState(deferQueueState = false): void {
    const active = this.store.active();
    this.post({
      type: 'statusBar',
      model: this.initialModel,
      version: this.hermesVersion,
      skillGroups: this.skillGroups,
    });
    for (const update of sessionReadyUiMessages(
      this.backgroundProcessesFor(active?.acpSessionId),
      this.agentActivitiesFor(active?.acpSessionId, active?.id),
      this.availableCommandsFor(active?.acpSessionId),
      this.contextUsageFor(active?.acpSessionId),
    )) this.post(update);
    this.broadcastProfileState();
    this.broadcastSessions(this.store);
    if (active && active.messages.length > 0) {
      this.post({ type: 'loadHistory', history: active.messages, activeSessionId: this.store.activeId });
    }
    // queueState is the final ready-handshake message: history and runtime
    // metadata are hydrated before composer submissions can race session binding.
    if (!deferQueueState) this.postQueueState();
  }

  private hydrateActiveRuntimeSession(): Promise<void> {
    if (this.runtimeHydration) return this.runtimeHydration;
    const hydration = this.performRuntimeHydration();
    this.runtimeHydration = hydration;
    return hydration.finally(() => {
      if (this.runtimeHydration === hydration) this.runtimeHydration = undefined;
    });
  }

  private async performRuntimeHydration(): Promise<void> {
    const active = this.store.active();
    if (!active) return;
    const localSessionId = active.id;

    try {
      await this.profileController?.ensureConnected?.();
      const acpSessionId = await this.session.ensureSession(this.resolveWorkingDirectory());
      if (this.store.activeId !== localSessionId) return;
      this.store.setAcpSessionId(acpSessionId);
      this.post({
        type: 'statusBar',
        availableCommands: this.availableCommandsFor(acpSessionId),
        agentActivities: this.agentActivitiesFor(acpSessionId, localSessionId),
        ...this.contextUsageFor(acpSessionId),
      });
    } catch (err) {
      this.log(`[session] metadata hydration failed: ${String(err)}`);
    }
  }

  dispose(): void {
    this.view = undefined;
    this.backgroundMessages.dispose();
    this.roleRunMonitor.dispose();
    this.delegationActivityMonitor.dispose();
  }

  private flushBackgroundMessage(acpSessionId: string, text: string): void {
    const view = this.view;
    routeBackgroundMessage({
      sessionId: acpSessionId,
      activeSessionId: this.store.getAcpSessionId(),
      text,
      canRender: view !== undefined,
      persistActive: message => this.store.addTurnMessages([], message),
      persistBySession: (sessionId, message) => { this.store.addAgentMessageByAcpSessionId(sessionId, message); },
      render: message => {
        if (!view) return;
        const converted = this.convertMediaPaths(message, view.webview);
        view.webview.postMessage({ type: 'backgroundNotification', text: converted });
      },
      broadcast: () => this.broadcastSessions(this.store),
    });
  }

  private updateBackgroundProcess(acpSessionId: string, process: BackgroundProcessState): void {
    let processes = this.backgroundProcessesBySession.get(acpSessionId);
    if (!processes) {
      processes = new Map<string, BackgroundProcessState>();
      this.backgroundProcessesBySession.set(acpSessionId, processes);
    }
    if (process.status === 'running') processes.set(process.id, process);
    else processes.delete(process.id);
    if (processes.size === 0) this.backgroundProcessesBySession.delete(acpSessionId);
    if (this.store.getAcpSessionId() === acpSessionId) this.showBackgroundProcesses(acpSessionId);
  }

  private showBackgroundProcesses(acpSessionId?: string): void {
    this.post({ type: 'statusBar', backgroundProcesses: this.backgroundProcessesFor(acpSessionId) });
  }

  private backgroundProcessesFor(acpSessionId?: string): BackgroundProcessState[] {
    const processes = acpSessionId ? this.backgroundProcessesBySession.get(acpSessionId) : undefined;
    return processes ? [...processes.values()] : [];
  }

  private agentActivitiesFor(acpSessionId?: string, _localSessionId = this.store.activeId): AgentActivity[] {
    const transport = acpSessionId ? this.agentActivitiesBySession.get(acpSessionId) : undefined;
    const delegationScope = this.sessionDelegationScope;
    const delegations = delegationScope
      && acpSessionId === delegationScope.sessionId
      && this.session.getRuntimeGeneration() === delegationScope.generation
      ? this.sessionDelegationActivities
      : [];
    const combined = new Map<string, AgentActivity>();
    for (const activity of [
      ...(transport ?? []),
      ...this.workspaceRoleActivities,
      ...delegations,
    ]) {
      combined.set(activity.id, { ...activity });
    }
    return [...combined.values()];
  }

  private availableCommandsFor(acpSessionId?: string): AvailableSlashCommand[] {
    const commands = acpSessionId ? this.availableCommandsBySession.get(acpSessionId) : undefined;
    return (commands ?? DEFAULT_AVAILABLE_COMMANDS).map(command => ({ ...command }));
  }

  private currentAvailableCommands(): AvailableSlashCommand[] {
    const acpSessionId = this.session.getSessionId() ?? this.store.getAcpSessionId();
    return this.availableCommandsFor(acpSessionId ?? undefined);
  }

  private contextUsageFor(acpSessionId?: string): SessionContextUsage | undefined {
    const usage = acpSessionId ? this.contextUsageBySession.get(acpSessionId) : undefined;
    return usage ? { ...usage } : undefined;
  }

  private isActiveRuntimeSession(acpSessionId: string): boolean {
    return this.session.getSessionId() === acpSessionId || this.store.getAcpSessionId() === acpSessionId;
  }

  private saveTurnToSession(): void {
    this.store.addTurnMessages(this.lastTurnTools, this.lastTurnText);
    this.lastTurnText = '';
    this.lastTurnTools = [];
  }

  private resolveWorkingDirectory(): string {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspaceFolder) return workspaceFolder;

    const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (activeEditorPath) {
      return path.dirname(activeEditorPath);
    }

    return process.cwd();
  }

  private async handleFromWebview(msg: FromWebview): Promise<void> {
    const changesRuntime = msg.type === 'ready'
      || msg.type === 'newSession'
      || msg.type === 'switchSession'
      || msg.type === 'deleteSession'
      || msg.type === 'selectProfile'
      || msg.type === 'customProfile'
      || msg.type === 'restartHermes';

    if (changesRuntime) {
      const previous = this.lifecycleTransition ?? Promise.resolve();
      const transition = previous.catch(() => {}).then(() => this.handleFromWebviewUnlocked(msg));
      this.lifecycleTransition = transition;
      try {
        await transition;
      } finally {
        if (this.lifecycleTransition === transition) this.lifecycleTransition = undefined;
      }
      return;
    }

    if (this.lifecycleTransition) await this.lifecycleTransition;
    await this.handleFromWebviewUnlocked(msg);
  }

  private async handleFromWebviewUnlocked(msg: FromWebview): Promise<void> {
    const changesRuntime = msg.type === 'newSession'
      || msg.type === 'switchSession'
      || msg.type === 'deleteSession'
      || msg.type === 'selectProfile'
      || msg.type === 'customProfile'
      || msg.type === 'restartHermes';
    if (this.busy && changesRuntime) {
      this.log(`[ui] blocked ${msg.type} while a prompt is active`);
      this.post({ type: 'notice', text: 'Stop or finish the active Hermes turn before changing sessions or profiles.' });
      return;
    }

    if (msg.type === 'ready') {
      this.emitInitialState(true);
      await this.hydrateActiveRuntimeSession();
      this.postQueueState();

    } else if (msg.type === 'send' && msg.text) {
      this.log(`[ui] send (${msg.text.length} chars)`);
      const request = this.capturePromptRequest(msg.text, msg.requestId);
      this.enqueueOrRun(request);

    } else if (msg.type === 'editQueuedMessage' && msg.requestId) {
      const text = msg.text?.trim();
      if (text) {
        const queued = editQueuedMessage(
          this.messageQueue,
          msg.requestId,
          text,
          isKnownSlashCommand(text, this.currentAvailableCommands()),
        );
        if (queued?.isSlashCommand) {
          queued.attachedFiles = [];
          queued.selectedSkills = [];
          queued.ideContext = '';
        }
      }
      this.postQueueState();

    } else if (msg.type === 'deleteQueuedMessage' && msg.requestId) {
      const queued = this.messageQueue.find(item => item.requestId === msg.requestId);
      if (!queued) {
        this.postQueueState();
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        'Delete this queued message?',
        { modal: true, detail: 'The message will not run after the active turn.' },
        'Delete',
      );
      if (choice === 'Delete') deleteQueuedMessage(this.messageQueue, msg.requestId);
      this.postQueueState();

    } else if (msg.type === 'cancel') {
      this.log(`[ui] cancel (${this.messageQueue.length} queued kept)`);
      // Don't clear the queue — queued messages should be sent after cancel
      this.lastTurnText = '';
      this.lastTurnTools = [];
      await this.session.cancel();

    } else if (msg.type === 'switchModel' && msg.model) {
      this.log(`[ui] switch model ${msg.model}`);
      const command = `/model ${msg.model}`;
      this.enqueueOrRun(this.createCommandRequest(command));

    } else if (msg.type === 'newSession') {
      this.log('[ui] new session');
      this.messageQueue = [];
      this.autonomousTurnId = undefined;
      this.lastTurnText = '';
      this.lastTurnTools = [];
      this.session.reset();
      this.store.createSession('new session');
      this.post({ type: 'clear' });
      this.post({
        type: 'statusBar',
        backgroundProcesses: [],
        agentActivities: [],
        availableCommands: this.currentAvailableCommands(),
      });
      this.broadcastSessions(this.store);
      await this.roleRunMonitor.refresh();
      await this.hydrateActiveRuntimeSession();

    } else if (msg.type === 'switchSession' && msg.sessionId) {
      this.log(`[ui] switch session ${msg.sessionId}`);
      const target = this.store.switchTo(msg.sessionId);
      if (!target) return;

      this.messageQueue = [];
      this.autonomousTurnId = undefined;
      this.lastTurnText = '';
      this.lastTurnTools = [];
      this.session.reset();
      if (target.acpSessionId) {
        this.session.setStoredSessionId(target.acpSessionId);
        this.log(`[session] will attempt resume of ACP session ${target.acpSessionId}`);
      }

      for (const update of sessionSwitchUiMessages(
        target.title,
        this.backgroundProcessesFor(target.acpSessionId),
        this.agentActivitiesFor(target.acpSessionId, target.id),
        this.availableCommandsFor(target.acpSessionId),
        this.contextUsageFor(target.acpSessionId),
      )) this.post(update);
      this.broadcastSessions(this.store);

      if (target.messages.length > 0) {
        this.post({ type: 'loadHistory', history: target.messages, activeSessionId: target.id });
      }
      await this.roleRunMonitor.refresh();
      await this.hydrateActiveRuntimeSession();

    } else if (msg.type === 'attachFile') {
      // Open file picker and send selected file info back to webview
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        filters: { 'All Files': ['*'] },
      });
      if (uris) {
        for (const uri of uris) this.setAttachedFile(uri.fsPath);
      }

    } else if (msg.type === 'pasteImage' && msg.data && msg.ext) {
      // Save pasted image to the extension's media cache so the webview never exposes arbitrary local paths.
      const extension = normalizePastedImageExtension(msg.ext);
      if (!extension) {
        this.log('[security] rejected pasted image with unsupported extension');
        return;
      }
      const tmpPath = path.join(this.mediaRoot, `hermes-paste-${Date.now()}.${extension}`);
      try {
        fs.writeFileSync(tmpPath, Buffer.from(msg.data, 'base64'));
        this.log('[ui] pasted image cached');
        this.setAttachedFile(tmpPath);
      } catch (err) {
        this.log(`[ui] failed to save pasted image: ${err}`);
      }

    } else if (msg.type === 'dropFiles' && msg.uris?.length) {
      // Handle files dropped from VS Code explorer — attach ALL dropped files
      for (const uri of msg.uris) {
        try {
          const fsPath = vscode.Uri.parse(uri).fsPath;
          this.log(`[ui] dropped file ${path.basename(fsPath)}`);
          this.setAttachedFile(fsPath);
        } catch (err) {
          this.log(`[ui] failed to parse dropped URI: ${err}`);
        }
      }

    } else if (msg.type === 'clearAttachments') {
      this.attachedFiles = [];

    } else if (msg.type === 'renameSession' && msg.sessionId) {
      const s = this.store.allSessions().find(s => s.id === msg.sessionId);
      if (!s) return;
      const newName = await vscode.window.showInputBox({
        prompt: 'Rename session',
        value: s.title,
        placeHolder: 'Session name',
      });
      if (newName !== undefined && newName.trim()) {
        this.store.rename(msg.sessionId, newName.trim());
        this.broadcastSessions(this.store);
        if (msg.sessionId === this.store.activeId) {
          this.post({ type: 'statusBar', sessionTitle: newName.trim().slice(0, 60) });
        }
      }

    } else if (msg.type === 'deleteSession' && msg.sessionId) {
      if (this.store.deleteSession(msg.sessionId)) {
        this.broadcastSessions(this.store);
      }

    } else if (msg.type === 'selectProfile') {
      const nextProfile = msg.text ?? '';
      this.log(`[ui] select profile ${profileDisplayName(nextProfile)}`);
      const restarted = await this.profileController?.selectProfile(nextProfile);
      if (restarted) {
        this.post({ type: 'clear' });
        await this.hydrateActiveRuntimeSession();
      }
      this.broadcastProfileState();

    } else if (msg.type === 'customProfile') {
      this.log('[ui] custom profile');
      const restarted = await this.profileController?.customProfile();
      if (restarted) {
        this.post({ type: 'clear' });
        await this.hydrateActiveRuntimeSession();
      }
      this.broadcastProfileState();

    } else if (msg.type === 'restartHermes') {
      this.log('[ui] restart Hermes for profile change');
      await this.profileController?.restartHermes();
      this.post({ type: 'clear' });
      await this.hydrateActiveRuntimeSession();
      this.broadcastProfileState();

    } else if (msg.type === 'toggleSkill' && msg.text) {
      const idx = this.selectedSkills.indexOf(msg.text);
      if (idx >= 0) {
        this.selectedSkills.splice(idx, 1);
      } else {
        this.selectedSkills.push(msg.text);
      }
      this.log(`[ui] skills: [${this.selectedSkills.join(', ')}]`);
      this.post({ type: 'statusBar', selectedSkills: this.selectedSkills });
    }
  }

  private setAttachedFile(fsPath: string): void {
    const name = path.basename(fsPath);
    // Don't add duplicates
    if (!this.attachedFiles.find(f => f.path === fsPath)) {
      this.attachedFiles.push({ name, path: fsPath });
    }
    this.post({ type: 'statusBar', attachedFiles: this.attachedFiles.map(f => ({ name: f.name, path: f.path })) });
  }

  /** Snapshot composer-owned context so later input cannot mutate a queued turn. */
  private capturePromptRequest(text: string, requestId?: string): PromptRequest {
    const isSlashCommand = isKnownSlashCommand(text, this.currentAvailableCommands());
    const request: PromptRequest = {
      text,
      ...(requestId ? { requestId } : {}),
      isSlashCommand,
      // The webview clears composer chips when any message is sent. Slash
      // commands have no user bubble and do not accept composer context, so
      // discard it here rather than annotating the previous prose turn.
      attachedFiles: isSlashCommand ? [] : this.attachedFiles.map(file => ({ ...file })),
      selectedSkills: isSlashCommand ? [] : [...this.selectedSkills],
      ideContext: isSlashCommand ? '' : this.collectIdeContext(),
    };

    if (this.attachedFiles.length > 0) {
      this.attachedFiles = [];
      this.post({ type: 'statusBar', attachedFiles: [] });
    }
    if (this.selectedSkills.length > 0) {
      this.selectedSkills = [];
      this.post({ type: 'statusBar', selectedSkills: [] });
    }
    return request;
  }

  private createCommandRequest(text: string): PromptRequest {
    return {
      text,
      isSlashCommand: isKnownSlashCommand(text, this.currentAvailableCommands()),
      attachedFiles: [],
      selectedSkills: [],
      ideContext: '',
    };
  }

  /** Serialize every prompt-producing action behind the active ACP turn. */
  private enqueueOrRun(request: PromptRequest): void {
    if (this.busy) {
      this.log(`[ui] queued (${request.text})`);
      this.messageQueue.push(request);
      this.post({
        type: 'busy',
        active: true,
        queued: this.messageQueue.length,
        queuedItems: editableQueuedMessages(this.messageQueue),
      });
      return;
    }
    void this.runPrompt(request);
  }

  /** Apply lifecycle sent by a server-initiated Lead continuation turn. */
  private handleAutonomousTurn(event: SessionUpdateEvent): void {
    const turn = event.autonomousTurn;
    if (!turn) return;
    if (turn.status === 'running') {
      this.autonomousTurnsBySession.set(event.session_id, { id: turn.id, text: '', tools: [] });
      if (!this.isActiveRuntimeSession(event.session_id)) return;
      // Persist/render the completion trigger before any model response. The
      // normal background accumulator deliberately waits for token chunks.
      this.backgroundMessages.flushSession(event.session_id);
      this.autonomousTurnId = turn.id;
      this.busy = true;
      this.post({
        type: 'busy',
        active: true,
        queued: this.messageQueue.length,
        queuedItems: editableQueuedMessages(this.messageQueue),
      });
      return;
    }
    const buffered = this.autonomousTurnsBySession.get(event.session_id);
    if (!buffered || buffered.id !== turn.id) return;
    this.autonomousTurnsBySession.delete(event.session_id);
    if (!this.isActiveRuntimeSession(event.session_id) || this.autonomousTurnId !== turn.id) {
      this.store.addTurnMessagesByAcpSessionId(event.session_id, buffered.tools, buffered.text);
      this.broadcastSessions(this.store);
      return;
    }
    this.autonomousTurnId = undefined;
    this.saveTurnToSession();
    this.post({ type: 'done' });
    if (turn.status === 'failed') {
      this.post({ type: 'notice', text: 'Autonomous continuation stopped unexpectedly.' });
    }
    this.advancePromptQueueOrIdle();
  }

  private advancePromptQueueOrIdle(): void {
    if (this.autonomousTurnId) {
      this.busy = true;
      this.activeRequest = undefined;
      this.post({
        type: 'busy',
        active: true,
        queued: this.messageQueue.length,
        queuedItems: editableQueuedMessages(this.messageQueue),
      });
    } else if (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift()!;
      this.busy = true;
      void this.runPrompt(next);
    } else {
      this.busy = false;
      this.activeRequest = undefined;
      this.post({ type: 'busy', active: false, queued: 0, queuedItems: [] });
    }
  }

  private captureAutonomousEvent(event: SessionUpdateEvent): boolean {
    const turnId = event.autonomousTurnId;
    if (!turnId) return false;
    const buffered = this.autonomousTurnsBySession.get(event.session_id);
    if (!buffered || buffered.id !== turnId) return false;
    if (this.isActiveRuntimeSession(event.session_id) && this.autonomousTurnId === turnId) return false;

    let captured = false;
    if (event.text) {
      buffered.text += event.text;
      captured = true;
    }
    if (event.toolTitle !== undefined) {
      captured = true;
      if (event.toolTitle) {
        const icon = event.toolStatus === 'done' || event.toolStatus === 'completed' ? '✓' : event.toolStatus === 'error' ? '✗' : '⋯';
        buffered.tools.push({
          role: 'tool',
          text: `${icon} ${event.toolTitle}${event.toolDetail ? ': ' + event.toolDetail : ''}`,
        });
      }
    }
    if (event.thinkingText || event.todoState || event.done || event.error) captured = true;
    return captured;
  }

  private async runPrompt(request: PromptRequest): Promise<void> {
    const { text } = request;
    this.log(`[ui] run prompt (${text.length} chars)`);
    this.activeRequest = request;

    // Persist only when the message becomes the active turn. Recording queued
    // input at submit time would place it before the current assistant reply
    // in restored history.
    if (!request.isSlashCommand) {
      const newTitle = this.store.autoTitle(text);
      if (newTitle) {
        this.post({ type: 'statusBar', sessionTitle: newTitle });
        this.broadcastSessions(this.store);
      }
      this.store.addUserMessage(text);
    }

    // Build context annotation when the matching user bubble is rendered.
    const lines: string[] = [];
    for (const f of request.attachedFiles) {
      lines.push(`<span class="ctx-line"><span class="ctx-icon">⊕</span>${f.name}</span>`);
    }
    for (const s of request.selectedSkills) {
      lines.push(`<span class="ctx-line"><span class="ctx-icon">✦</span>${s}</span>`);
    }

    this.busy = true;
    this.post({
      type: 'busy',
      active: true,
      queued: this.messageQueue.length,
      queuedItems: editableQueuedMessages(this.messageQueue),
      startedText: text,
      startedSlashCommand: request.isSlashCommand,
      ...(request.requestId ? { startedRequestId: request.requestId } : {}),
    });
    // The acknowledgement above renders the matching user bubble first.
    if (lines.length > 0) {
      this.post({ type: 'statusBar', contextAnnotation: lines.join('') });
    }
    const cwd = this.resolveWorkingDirectory();

    // Prepend IDE context + attached file for regular messages (not slash commands)
    let prompt = text;
    if (!request.isSlashCommand) {
      const ctx = request.ideContext;
      if (ctx) {
        prompt = ctx + prompt;
        this.log(`[ui] attached IDE context (${ctx.length} chars)`);
      }

      // Inject the skills captured with this composer submission.
      if (request.selectedSkills.length > 0) {
        prompt = `I advise you to use the following skills: ${request.selectedSkills.join(', ')}\n\n${prompt}`;
        this.log(`[ui] advised skills: ${request.selectedSkills.join(', ')}`);
      }

      // Attach the file paths captured with this composer submission.
      if (request.attachedFiles.length > 0) {
        const refs = request.attachedFiles.map(f => `[Referenced file: ${f.path}]`).join('\n');
        prompt = refs + '\n\n' + prompt;
        this.log(`[ui] attached ${request.attachedFiles.length} file ref(s)`);
      }
    }

    try {
      // SessionManager establishes turn cancellation ownership before binding,
      // including reconnect, while the binding callback persists ACP ownership
      // before session/prompt.
      await sendPromptWithSessionBinding(
        this.session,
        this.store,
        prompt,
        cwd,
        async () => { await this.profileController?.ensureConnected?.(); },
      );
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Cancelled')) {
        this.post({ type: 'done' });
      } else {
        this.log(`[ui] prompt error ${msg}`);
        this.post({ type: 'error', text: msg });
      }
    } finally {
      this.log('[ui] prompt finished');
      this.advancePromptQueueOrIdle();
    }
  }

  /** Collect current IDE context to prepend to user prompts. */
  private collectIdeContext(): string {
    const parts: string[] = [];

    // Active editor file + selection
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const filePath = vscode.workspace.asRelativePath(editor.document.uri);
      parts.push(`[Active file: ${filePath}]`);

      const selection = editor.selection;
      if (!selection.isEmpty) {
        const selectedText = editor.document.getText(selection);
        if (selectedText.length <= 2000) {
          const startLine = selection.start.line + 1;
          const endLine = selection.end.line + 1;
          parts.push(`[Selection lines ${startLine}-${endLine}]\n\`\`\`\n${selectedText}\n\`\`\``);
        } else {
          parts.push(`[Selection: ${selectedText.length} chars, lines ${selection.start.line + 1}-${selection.end.line + 1}]`);
        }
      }
    }

    // Open editor tabs (just filenames, not content)
    const openTabs = vscode.window.tabGroups.all
      .flatMap(g => g.tabs)
      .map(t => {
        if (t.input && typeof t.input === 'object' && 'uri' in (t.input as Record<string, unknown>)) {
          return vscode.workspace.asRelativePath((t.input as { uri: vscode.Uri }).uri);
        }
        return null;
      })
      .filter((p): p is string => p !== null);

    if (openTabs.length > 0) {
      parts.push(`[Open tabs: ${openTabs.join(', ')}]`);
    }

    return parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  }

  /** Open a file in VS Code editor when Hermes edits/reads it. */
  private openFileInEditor(filePath: string, isEdit: boolean): void {
    try {
      const uri = vscode.Uri.file(filePath);
      vscode.workspace.openTextDocument(uri).then(doc => {
        vscode.window.showTextDocument(doc, {
          preserveFocus: true,  // keep focus on the chat panel
          preview: !isEdit,     // edits open as persistent tabs, reads as preview
          viewColumn: vscode.ViewColumn.One,
        });
        this.log(`[ui] opened ${isEdit ? 'edited' : 'read'} file ${path.basename(filePath)}`);
      }, err => {
        this.log(`[ui] failed to open file: ${err}`);
      });
    } catch (err) {
      this.log(`[ui] openFileInEditor error: ${err}`);
    }
  }

  /** Convert MEDIA:/absolute/path references to webview-safe <img> tags. */
  private convertMediaPaths(text: string, webview: vscode.Webview): string {
    return text.replace(/MEDIA:(\/[^\s\n]+)/g, (_match, filePath: string) => {
      if (!this.isAllowedMediaPath(filePath)) {
        return `[blocked image: ${path.basename(filePath)}]`;
      }
      const uri = webview.asWebviewUri(vscode.Uri.file(filePath));
      return `![image](${uri})`;
    });
  }

  private isAllowedMediaPath(filePath: string): boolean {
    const normalizedFile = path.resolve(filePath);
    const normalizedRoot = path.resolve(this.mediaRoot) + path.sep;
    const allowedExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
    return normalizedFile.startsWith(normalizedRoot) && allowedExt.has(path.extname(normalizedFile).toLowerCase());
  }


  public refreshProfileState(): void {
    this.broadcastProfileState();
  }

  private broadcastProfileState(): void {
    if (!this.profileController) return;
    const profile = this.profileController.currentProfile();
    this.post({
      type: 'profileList',
      profile,
      profileItems: this.profileController.profileItems(),
      restartRequired: this.profileController.restartRequired(),
    });
  }

  private broadcastSessions(_store: SessionStore): void {
    this.post({
      type: 'sessionList',
      sessions: _store.allSessionsReversed(),
      activeSessionId: _store.activeId,
      sessionTitle: _store.active()?.title,
    });
  }


  private buildHtml(webview: vscode.Webview): string {
    return buildChatHtml({
      extensionUri: this.extensionUri,
      webview,
      initialModel: this.initialModel,
      modelGroups: this.modelGroups,
    });
  }
}
