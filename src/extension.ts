import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { AcpClient } from './acpClient';
import { normalizeHermesProfile } from './acpLaunchArgs';
import { buildProfileMenuItems, isProfileRestartRequired, parseHermesProfileList, profileDisplayName } from './profileUi';
import { PermissionRequestHandler, SessionManager } from './sessionManager';
import { ChatPanelProvider } from './chatPanel';
import { selectedPermissionResponse } from './permissionResponse';
import { applyProfileSelection } from './profileSelection';
import { ensureAcpClientStarted } from './connectionLifecycle';
import { activeHermesHome, setActiveHermesHome } from './paths/hermesHome';
import { buildRuntimeEnv } from './runtime/process';
import { readActive } from './runtime/installer';
import { redact } from './secrets/redactor';
import { purgeTerminalSnapshots } from './runtime/terminalSnapshots';
import {
  RemoteSessionPublisher, pairDevice, pairedDevice, unpairDevice,
} from './remoteControl';
import { RuntimeService } from './runtimeService';
import type { ResolvedRuntime } from './runtimeService';
import { ProviderService } from './providerService';
import { testConnection, summarize as summarizeConnectionTest } from './providers/connectionTest';
import { DEFAULT_TIMEOUT_SECONDS, newProfileId } from './providers/profile';
import type { ProviderProfile } from './providers/profile';
import { SkillsService } from './skillsService';
import {
  EDIT_APPROVAL_MODES,
  EditApprovalModeId,
  editApprovalModeLabel,
  normalizeEditApprovalMode,
} from './editApprovalMode';

const DEFAULT_SONNET_MODEL = 'claude-sonnet-4-6';
const APPROVED_BINARIES_KEY = 'hermesRangelTech.approvedBinaries';

function extractModelFromHermesConfig(content: string): string | null {
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const modelMatch = /^(\s*)model:\s*(.*)$/.exec(line);
    if (!modelMatch) continue;

    const modelIndent = modelMatch[1].length;
    const inlineValue = modelMatch[2].trim();
    if (inlineValue) {
      return inlineValue;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const childLine = lines[j];
      if (!childLine.trim() || childLine.trimStart().startsWith('#')) continue;

      const childIndent = childLine.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= modelIndent) break;

      const defaultMatch = /^\s*default:\s*(\S+)/.exec(childLine);
      if (defaultMatch) {
        return defaultMatch[1];
      }
    }
  }

  return null;
}

function readHermesModel(): { model: string; source: 'env' | 'config' | 'fallback' } {
  try {
    const configPath = path.join(activeHermesHome(), 'config.yaml');
    const content = fs.readFileSync(configPath, 'utf8');
    const model = extractModelFromHermesConfig(content);
    if (model) {
      return { model, source: 'config' };
    }
  } catch {
    // Fall through to the built-in Sonnet default.
  }

  return { model: DEFAULT_SONNET_MODEL, source: 'fallback' };
}

function readHermesVersion(hermesPath: string): string {
  try {
    const output = execFileSync(hermesPath, ['--version'], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${path.dirname(hermesPath)}${path.delimiter}${process.env.PATH ?? ''}` },
    });
    const match = output.match(/(\d+\.\d+\.\d+)/);
    return match?.[1] ? `v${match[1]}` : '';
  } catch {
    return '';
  }
}

function readConfiguredHermesProfile(): { value: string; workspaceOverrideIgnored: boolean } {
  const hermesConfig = vscode.workspace.getConfiguration('hermesRangelTech');
  const inspected = hermesConfig.inspect<string>('profile');
  const workspaceOverrideIgnored = !!(inspected?.workspaceValue || inspected?.workspaceFolderValue);
  const value = normalizeHermesProfile(inspected?.globalValue ?? inspected?.defaultValue ?? '');
  return { value, workspaceOverrideIgnored };
}

function readConfiguredEditApprovalMode(): { value: EditApprovalModeId; workspaceOverrideIgnored: boolean } {
  const hermesConfig = vscode.workspace.getConfiguration('hermesRangelTech');
  const inspected = hermesConfig.inspect<string>('editApprovalMode');
  const workspaceOverrideIgnored = !!(inspected?.workspaceValue || inspected?.workspaceFolderValue);
  const value = normalizeEditApprovalMode(inspected?.globalValue ?? inspected?.defaultValue ?? 'dont_ask');
  return { value, workspaceOverrideIgnored };
}

function resolveWorkingDirectory(): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspaceFolder) return workspaceFolder;
  const activeEditorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
  return activeEditorPath ? path.dirname(activeEditorPath) : process.cwd();
}

function profileLabel(profile: string, defaultProfileName = ''): string {
  const displayName = profileDisplayName(profile, defaultProfileName);
  return profile ? `profile ${displayName}` : `default profile (${displayName})`;
}

function readDefaultHermesProfileName(): string {
  try {
    return fs.readFileSync(path.join(activeHermesHome(), 'default_profile_name'), 'utf8').trim();
  } catch {
    return '';
  }
}

function profileRestartRequired(client: AcpClient | null): boolean {
  return isProfileRestartRequired(!!client?.running, client?.selectedProfile ?? '', client?.launchedProfile ?? '');
}

function buildProfileState(hermesPath: string, currentProfile: string, restartRequired: boolean, defaultProfileName = '', env: NodeJS.ProcessEnv = process.env) {
  const profiles = readAvailableHermesProfiles(hermesPath, env);
  if (currentProfile && !profiles.includes(currentProfile)) profiles.push(currentProfile);
  return {
    profile: currentProfile,
    profileItems: buildProfileMenuItems(profiles, currentProfile, defaultProfileName),
    restartRequired,
  };
}

function readAvailableHermesProfiles(hermesPath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    const output = execFileSync(hermesPath, ['profile', 'list'], {
      timeout: 5000,
      encoding: 'utf8',
      env: { ...env, PATH: `${path.dirname(hermesPath)}${path.delimiter}${env.PATH ?? ''}` },
      windowsHide: true,
    });
    return parseHermesProfileList(output);
  } catch {
    return [];
  }
}

async function ensureTrustedBinary(
  context: vscode.ExtensionContext,
  hermesPath: string,
): Promise<boolean> {
  const approved = context.globalState.get<string[]>(APPROVED_BINARIES_KEY, []);
  if (approved.includes(hermesPath)) return true;

  const allow = 'Allow';
  const choice = await vscode.window.showWarningMessage(
    `Hermes wants to launch this local binary:\n${hermesPath}\n\nOnly allow binaries you trust.`,
    { modal: true },
    allow,
  );
  if (choice !== allow) return false;

  await context.globalState.update(APPROVED_BINARIES_KEY, [...new Set([...approved, hermesPath])]);
  return true;
}

function summarizePermissionRequest(params: unknown): string {
  if (!params || typeof params !== 'object') return 'Hermes requested permission for an action.';
  const record = params as Record<string, unknown>;
  const toolName = typeof record.toolName === 'string'
    ? record.toolName
    : typeof record.title === 'string'
      ? record.title
      : typeof record.kind === 'string'
        ? record.kind
        : 'an action';
  const reason = typeof record.reason === 'string'
    ? record.reason
    : typeof record.description === 'string'
      ? record.description
      : '';
  return reason
    ? `Hermes requested permission for ${toolName}: ${reason}`
    : `Hermes requested permission for ${toolName}.`;
}

function optionIdByIntent(params: unknown, intent: 'allow' | 'deny'): string | null {
  if (!params || typeof params !== 'object') return null;
  const options = (params as { options?: Array<Record<string, unknown>> }).options;
  if (!Array.isArray(options)) return null;

  const preferredAllow = ['allow_once', 'allow', 'approve', 'yes'];
  const preferredDeny = ['deny_once', 'deny', 'reject', 'no'];
  const preferred = intent === 'allow' ? preferredAllow : preferredDeny;

  for (const keyword of preferred) {
    const match = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id.toLowerCase().includes(keyword);
    });
    if (match) {
      return (typeof match.optionId === 'string' ? match.optionId : match.id) as string;
    }
  }

  if (intent === 'allow') {
    const fallback = options.find((option) => {
      const id = typeof option.optionId === 'string' ? option.optionId : typeof option.id === 'string' ? option.id : '';
      return id && !/deny|reject|no/i.test(id);
    });
    return (typeof fallback?.optionId === 'string' ? fallback.optionId : fallback?.id as string | undefined) ?? null;
  }

  return null;
}

let client: AcpClient | null = null;
let currentHermesHome: string | null = null;
let outputChannel: vscode.OutputChannel;

function logLine(line: string): void {
  outputChannel.appendLine(redact(line));
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('Hermes by Rangel Tech');
  context.subscriptions.push(outputChannel);

  const runtimeService = new RuntimeService(context, logLine);
  const providerService = new ProviderService(context, logLine, runtimeService.paths.state);
  const skillsService = new SkillsService(context, logLine, runtimeService.paths);

  // CLI executable of the runtime in use. Filled in by ensureConnected.
  let hermesPath = '';
  let launchEnv: NodeJS.ProcessEnv | null = null;
  const configuredProfile = readConfiguredHermesProfile();
  if (configuredProfile.workspaceOverrideIgnored) {
    logLine('[security] Ignoring workspace-scoped profile override');
  }
  let hermesProfile = configuredProfile.value;
  let defaultProfileName = readDefaultHermesProfileName();
  const configuredEditApproval = readConfiguredEditApprovalMode();
  if (configuredEditApproval.workspaceOverrideIgnored) {
    logLine('[security] Ignoring workspace-scoped hermes.editApprovalMode override');
  }
  let editApprovalMode = configuredEditApproval.value;

  logLine(`[hermes] platform: ${process.platform}-${process.arch}`);
  logLine(`[hermes] data folder: ${runtimeService.paths.root}`);
  logLine(`[hermes] runtime mode: ${runtimeService.mode()}`);
  logLine(`[security] edit approval mode: ${editApprovalMode}`);

  const hermesConfig = vscode.workspace.getConfiguration('hermesRangelTech');
  const debugLogs = hermesConfig.get<boolean>('debugLogs', false);

  const debugEnv: NodeJS.ProcessEnv = debugLogs ? { HERMES_LOG_LEVEL: 'DEBUG' } : {};
  client = new AcpClient(
    hermesPath,
    () => launchEnv ?? { ...process.env, ...debugEnv },
    debugLogs,
    hermesProfile,
  );

  if (debugLogs) {
    outputChannel.show(true);
    logLine('[hermes] ACP diagnostic logging enabled');
  }

  client.on('log', (line: string) => logLine(line));
  client.on('exit', (code: number) => {
    logLine(`[hermes acp exited: code ${code}]`);
    setStatus('disconnected');
  });

  const permissionHandler: PermissionRequestHandler = async (_method, params) => {
    const allowOptionId = optionIdByIntent(params, 'allow');
    const denyOptionId = optionIdByIntent(params, 'deny');

    // Default: keep Hermes working without waiting on the user. Configurable; see
    // hermesRangelTech.autoApprovePermissions and docs/agentic-reliability-debug.md.
    const autoApprove = vscode.workspace.getConfiguration('hermesRangelTech').get<boolean>('autoApprovePermissions', true);
    if (autoApprove && allowOptionId) {
      logLine(`[security] auto-approved: ${summarizePermissionRequest(params)}`);
      return selectedPermissionResponse(allowOptionId);
    }

    const allow = 'Allow Once';
    const deny = 'Deny';
    const choice = await vscode.window.showWarningMessage(
      summarizePermissionRequest(params),
      { modal: true },
      allow,
      deny,
    );

    if (choice === allow && allowOptionId) {
      logLine('[security] permission granted once');
      return selectedPermissionResponse(allowOptionId);
    }

    if (denyOptionId) {
      logLine('[security] permission denied');
      return selectedPermissionResponse(denyOptionId);
    }

    throw new Error('Permission denied by user');
  };

  const session = new SessionManager(
    client,
    line => logLine(line),
    permissionHandler,
    editApprovalMode,
  );
  const hermesModel = providerService.store.active()?.model ?? readHermesModel().model;
  const hermesVersion = readActive(runtimeService.paths)?.hermes.ref.replace(/^v/, '') ?? '';
  const applySelectedProfile = async (nextProfile: string, source: string) => {
    const result = await applyProfileSelection(nextProfile, {
      currentProfile: () => hermesProfile,
      persistProfile: async profile => {
        await vscode.workspace.getConfiguration('hermesRangelTech').update('profile', profile, vscode.ConfigurationTarget.Global);
      },
      setCurrentProfile: profile => { hermesProfile = profile; },
      setClientProfile: profile => { client?.setProfile(profile); },
      isClientRunning: () => client?.running ?? false,
      stopClient: () => { client?.stop(); },
      resetSession: () => { session.reset(); },
      ensureConnected,
      setDisconnected: () => { setStatus('disconnected'); },
    });
    if (result.changed) {
      logLine(`[hermes] selected ${profileLabel(result.profile, defaultProfileName)} from ${source}`);
    }
    return result;
  };
  const panel = new ChatPanelProvider(
    context.extensionUri,
    session,
    hermesModel,
    hermesVersion,
    context,
    line => logLine(line),
    {
      currentProfile: () => hermesProfile,
      profileItems: () => buildProfileState(hermesPath, hermesProfile, profileRestartRequired(client), defaultProfileName, launchEnv ?? process.env).profileItems,
      restartRequired: () => profileRestartRequired(client),
      selectProfile: async (nextProfile: string) => {
        const result = await applySelectedProfile(nextProfile, 'webview');
        return result.restarted;
      },
      customProfile: async () => {
        const typed = await vscode.window.showInputBox({
          prompt: 'Hermes profile name. Leave empty for default profile.',
          value: hermesProfile,
        });
        if (typed === undefined) return false;
        const result = await applySelectedProfile(typed, 'webview');
        return result.restarted;
      },
      restartHermes: async () => {
        if (!client?.running) return;
        client.stop();
        session.reset();
        await ensureConnected();
      },
      ensureConnected,
    },
  );

  context.subscriptions.push(
    panel,
    vscode.window.registerWebviewViewProvider(ChatPanelProvider.viewId, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const remotePublisher = new RemoteSessionPublisher(
    context,
    session,
    logLine,
    text => panel.requestRemotePrompt(text),
    () => panel.isIdle(),
  );
  context.subscriptions.push(remotePublisher);

  /** Drives the gear-bar login/logout icon swap (view/title menu `when`
   * clauses in package.json key off this) — set on activation and on every
   * sign-in/sign-out so the toolbar always reflects the real pairing state. */
  async function updateRemotePairedContext(): Promise<void> {
    const device = await pairedDevice(context);
    await vscode.commands.executeCommand('setContext', 'hermesRangelTech.remotePaired', Boolean(device));
    await panel.refreshRemoteAuthState();
  }

  panel.setRemoteAuthController({
    isConfigured: () => Boolean((vscode.workspace.getConfiguration('hermesRangelTech').get<string>('remote.baseUrl') || '').trim()),
    currentDevice: () => pairedDevice(context),
    login: async (email, password) => {
      const device = await pairDevice(context, email, password);
      await updateRemotePairedContext();
      await attachRemoteIfPaired();
      return device;
    },
    logout: async () => {
      await unpairDevice(context);
      remotePublisher.detach();
      await updateRemotePairedContext();
    },
  });

  panel.setProviderSettingsController({
    current: () => {
      const active = providerService.store.active();
      return active
        ? { name: active.name, baseUrl: active.baseUrl, model: active.model, hasKey: true }
        : undefined;
    },
    save: async (input) => {
      const active = providerService.store.active();
      // input.id names the profile actually open in the form -- without it,
      // Save always overwrote whichever profile happened to be active, so
      // "+ New profile" could never really add a second one (found while
      // wiring the multi-profile picker, spec critério 5).
      const editing = input.id ? providerService.store.get(input.id) : undefined;
      const profile: ProviderProfile = {
        id: editing?.id ?? newProfileId(input.name),
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        timeoutSeconds: editing?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        allowInsecureHttp: input.allowInsecureHttp,
      };
      await providerService.store.save(profile, input.apiKey);
      await providerService.store.setActive(profile.id);
    },
    test: async (input) => {
      const editing = input.id ? providerService.store.get(input.id) : undefined;
      const draft: ProviderProfile = {
        id: editing?.id ?? 'draft',
        name: input.name,
        baseUrl: input.baseUrl,
        model: input.model,
        timeoutSeconds: editing?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        allowInsecureHttp: input.allowInsecureHttp,
      };
      const apiKey = input.apiKey ?? (editing ? await providerService.store.apiKey(editing.id) : undefined);
      const result = await testConnection(draft, apiKey);
      return { ok: result.ok, summary: summarizeConnectionTest(result) };
    },
    list: () => {
      const activeId = providerService.store.activeId();
      return providerService.store.list().map(p => ({ id: p.id, name: p.name, active: p.id === activeId }));
    },
    select: async (id) => {
      await providerService.store.setActive(id);
      const profile = providerService.store.get(id);
      return profile ? { name: profile.name, baseUrl: profile.baseUrl, model: profile.model, hasKey: true } : undefined;
    },
    remove: async (id) => {
      await providerService.store.remove(id);
    },
  });

  async function attachRemoteIfPaired(): Promise<void> {
    const device = await pairedDevice(context);
    await updateRemotePairedContext();
    if (!device) return;
    const externalSessionId = context.workspaceState.get<string>('hermesRangelTech.externalSessionId')
      ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await context.workspaceState.update('hermesRangelTech.externalSessionId', externalSessionId);
    await remotePublisher.attach({
      externalSessionId,
      workspacePath: resolveWorkingDirectory(),
      providerName: providerService.store.active()?.name,
      modelName: providerService.store.active()?.model,
    });
    logLine(`[remote] published as device "${device.name}"`);
  }
  void updateRemotePairedContext();

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('hermesRangelTech.openChat', async () => {
      logLine('[ui] open chat');
      await vscode.commands.executeCommand('hermesRangelTech.chatView.focus');
      await ensureConnected();
    }),

    vscode.commands.registerCommand('hermesRangelTech.restartAgent', async () => {
      logLine('[hermes] restarting ACP from command palette');
      if (await panel.requestHermesRestart()) {
        vscode.window.showInformationMessage('Hermes Agent restarted.');
      }
    }),

    vscode.commands.registerCommand('hermesRangelTech.newSession', async () => {
      logLine('[ui] new session');
      await panel.requestNewSession();
    }),

    vscode.commands.registerCommand('hermesRangelTech.selectProfile', async () => {
      logLine('[ui] select profile');
      const profiles = readAvailableHermesProfiles(hermesPath, launchEnv ?? process.env);
      const picked = await vscode.window.showQuickPick(
        [
          { label: profileDisplayName('', defaultProfileName), description: 'Use Hermes current/default profile', profile: '' },
          ...profiles.map(profile => ({ label: profile, description: 'Hermes profile', profile })),
          { label: '$(pencil) Enter custom profile…', description: 'Type a profile name manually', profile: undefined },
        ],
        { placeHolder: `Current: ${profileLabel(hermesProfile, defaultProfileName)}` },
      );
      if (!picked) return;

      let nextProfile = picked.profile;
      if (nextProfile === undefined) {
        const typed = await vscode.window.showInputBox({
          prompt: 'Hermes profile name. Leave empty for default profile.',
          value: hermesProfile,
        });
        if (typed === undefined) return;
        nextProfile = typed;
      }

      nextProfile = normalizeHermesProfile(nextProfile);
      await panel.requestProfileSelection(nextProfile);
    }),

    vscode.commands.registerCommand('hermesRangelTech.selectEditApprovalMode', async () => {
      logLine('[ui] select edit approval mode');
      const picked = await vscode.window.showQuickPick(
        EDIT_APPROVAL_MODES.map(mode => ({
          label: mode.label,
          description: mode.description,
          detail: mode.id === editApprovalMode ? 'Current mode' : undefined,
          modeId: mode.id,
        })),
        {
          placeHolder: `Current: ${editApprovalModeLabel(editApprovalMode)}`,
          title: 'Hermes edit approval mode',
        },
      );
      if (!picked || picked.modeId === editApprovalMode) return;

      try {
        await ensureConnected();
        if (!client?.running) throw new Error('ACP client is not connected');
        await session.setEditApprovalMode(picked.modeId, resolveWorkingDirectory());
        await vscode.workspace.getConfiguration('hermesRangelTech').update(
          'editApprovalMode',
          picked.modeId,
          vscode.ConfigurationTarget.Global,
        );
        editApprovalMode = picked.modeId;
        logLine(`[security] edit approval mode changed to ${editApprovalMode}`);
        void vscode.window.showInformationMessage(
          `Hermes edit approval mode: ${editApprovalModeLabel(editApprovalMode)}.`,
        );
      } catch (err) {
        logLine(`[security] failed to change edit approval mode: ${err}`);
        void vscode.window.showErrorMessage(`Hermes: failed to change edit approval mode — ${err}`);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('hermesRangelTech.setup', async () => {
      logLine('[ui] setup');
      await vscode.commands.executeCommand('hermesRangelTech.openChat');
    }),
    vscode.commands.registerCommand('hermesRangelTech.configureProvider', async () => {
      const profile = await providerService.configure();
      if (profile) {
        logLine(`[ui] provider "${profile.name}" saved`);
        await restartIfRunning();
        if (!client?.running) await ensureConnected();
      }
    }),
    vscode.commands.registerCommand('hermesRangelTech.testConnection', () => providerService.testActive()),
    vscode.commands.registerCommand('hermesRangelTech.configureSkills', async () => {
      if (await skillsService.configure()) await restartIfRunning();
    }),
    vscode.commands.registerCommand('hermesRangelTech.syncSkills', async () => {
      const outcome = await skillsService.syncNow('manual');
      if (outcome?.state === 'updated') await restartIfRunning();
    }),
    vscode.commands.registerCommand('hermesRangelTech.installRuntime', async () => {
      const wasRunning = client?.running ?? false;
      if (wasRunning) client?.stop();
      const active = await runtimeService.install();
      if (active) { session.reset(); await ensureConnected(); }
    }),
    vscode.commands.registerCommand('hermesRangelTech.selectPortableRuntime', async () => {
      if (await runtimeService.selectPortable()) { client?.stop(); session.reset(); await ensureConnected(); }
    }),
    vscode.commands.registerCommand('hermesRangelTech.runtimeStatus', async () => {
      const text = await runtimeService.status();
      logLine(`[runtime] status\n${text}`);
      void vscode.window.showInformationMessage(text, { modal: true });
    }),
    vscode.commands.registerCommand('hermesRangelTech.showLogs', () => outputChannel.show(true)),
    vscode.commands.registerCommand('hermesRangelTech.remoteLogin', async () => {
      const email = await vscode.window.showInputBox({ title: 'RIA Atendimento email', ignoreFocusOut: true });
      if (!email) return;
      const password = await vscode.window.showInputBox({
        title: 'RIA Atendimento password', password: true, ignoreFocusOut: true,
      });
      if (!password) return;
      try {
        const device = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Hermes: signing in to RIA Atendimento' },
          () => pairDevice(context, email, password),
        );
        logLine(`[remote] paired as device "${device.name}" (${device.id})`);
        void vscode.window.showInformationMessage(`Hermes: signed in as "${device.name}" in RIA Atendimento.`);
        await attachRemoteIfPaired();
      } catch (err) {
        logLine(`[remote] pairing failed: ${err}`);
        void vscode.window.showErrorMessage(`Hermes: sign-in failed — ${err instanceof Error ? err.message : err}`);
      }
    }),
    vscode.commands.registerCommand('hermesRangelTech.remoteLogout', async () => {
      await unpairDevice(context);
      remotePublisher.detach();
      await updateRemotePairedContext();
      logLine('[remote] signed out');
      void vscode.window.showInformationMessage('Hermes: signed out of RIA Atendimento.');
    }),
  );

  // Status bar
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusItem.text = `$(circle-outline) Hermes: ${profileDisplayName(hermesProfile, defaultProfileName)}`;
  statusItem.command = 'hermesRangelTech.openChat';
  statusItem.show();
  context.subscriptions.push(statusItem);

  function setStatus(state: 'connected' | 'disconnected' | 'connecting'): void {
    const icons: Record<string, string> = {
      connected: '$(circle-filled)',
      disconnected: '$(circle-outline)',
      connecting: '$(loading~spin)',
    };
    statusItem.text = `${icons[state]} Hermes: ${profileDisplayName(hermesProfile, defaultProfileName)}`;
    panel.post({ type: 'status', status: state });
    panel.refreshProfileState();
  }

  let connecting: Promise<void> | null = null;
  function ensureConnected(): Promise<void> {
    if (!connecting) {
      connecting = doEnsureConnected().finally(() => { connecting = null; });
    }
    return connecting;
  }

  async function restartIfRunning(): Promise<void> {
    if (!client?.running) return;
    client.stop();
    session.reset();
    await ensureConnected();
  }

  async function doEnsureConnected(): Promise<void> {
    if (!client) return;
    if (!vscode.workspace.isTrusted) {
      logLine('[security] workspace is not trusted; Hermes launch blocked');
      setStatus('disconnected');
      void vscode.window.showWarningMessage('Hermes is disabled until this workspace is trusted.');
      return;
    }

    const resolved: ResolvedRuntime | null = await runtimeService.resolve(true);
    if (!resolved) {
      setStatus('disconnected');
      return;
    }
    logLine(`[runtime] using ${resolved.label}`);
    setActiveHermesHome(resolved.hermesHome);
    hermesPath = resolved.cliExe;
    defaultProfileName = readDefaultHermesProfileName();

    if (resolved.managed) {
      const provider = await providerService.ensureActive(true);
      if (!provider) {
        logLine('[provider] no provider configured');
        setStatus('disconnected');
        const go = await vscode.window.showWarningMessage('Hermes needs a provider (endpoint, model and key) before it can start.', 'Configure provider');
        if (go) void vscode.commands.executeCommand('hermesRangelTech.configureProvider');
        return;
      }
      try {
        const extra = await providerService.prepare(resolved, provider);
        launchEnv = buildRuntimeEnv(process.env, { hermesHome: resolved.hermesHome, extra });
        Object.assign(launchEnv, debugEnv);
      } catch (err) {
        logLine(`[provider] could not apply settings: ${err}`);
        setStatus('disconnected');
        void vscode.window.showErrorMessage(`Hermes: ${err instanceof Error ? err.message : err}`);
        return;
      }
      currentHermesHome = resolved.hermesHome;
      purgeTerminalSnapshots(resolved.hermesHome);
      client.setLaunchArgs(resolved.entryArgs);
      await skillsService.prepareForLaunch(resolved);
    } else {
      // An existing Hermes keeps its own home, profiles and provider settings.
      launchEnv = { ...process.env, ...debugEnv };
      client.setLaunchArgs(null);
      const approved = await ensureTrustedBinary(context, resolved.entryExe);
      if (!approved) {
        logLine('[security] Hermes launch cancelled by user');
        setStatus('disconnected');
        return;
      }
    }

    const configuredProfileNow = readConfiguredHermesProfile();
    if (configuredProfileNow.workspaceOverrideIgnored) {
      logLine('[security] Ignoring workspace-scoped profile override');
    }
    hermesProfile = configuredProfileNow.value;
    client.setHermesPath(resolved.entryExe);
    client.setProfile(hermesProfile);

    try {
      await ensureAcpClientStarted(
        client,
        () => {
          logLine('[acp] connecting');
          setStatus('connecting');
        },
        () => {
          logLine('[acp] connected');
          setStatus('connected');
          void attachRemoteIfPaired();
        },
      );
    } catch (err) {
      logLine(`[acp] connect failed: ${err}`);
      setStatus('disconnected');
      vscode.window.showErrorMessage(`Hermes: failed to start — ${err}`);
    }
  }

  if (skillsService.syncOnStartup() && skillsService.config()) void skillsService.syncNow('startup');

  // Auto-connect
  if (vscode.workspace.isTrusted) {
    void ensureConnected();
  } else {
    setStatus('disconnected');
  }
}

export function deactivate(): void {
  client?.stop();
  if (currentHermesHome) {
    try { purgeTerminalSnapshots(currentHermesHome); } catch { /* best effort */ }
  }
}
