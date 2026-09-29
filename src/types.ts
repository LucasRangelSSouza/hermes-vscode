/**
 * Shared type definitions for the Hermes VS Code extension.
 * Used by both the extension host (Node.js) and webview (browser).
 */

import type { SkillGroup } from './skillCatalog';
import type { ProfileMenuItem } from './profileUi';
import type { QueuedWebviewMessage } from './webviewQueue';
import type { AgentActivity } from './agentActivity';
import type { AvailableSlashCommand } from './slashCommands';

// ── Session & History ────────────────────────────────

export interface StoredMessage {
  role: 'user' | 'agent' | 'tool' | 'error';
  text: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  messages: StoredMessage[];
  acpSessionId?: string;
}

// ── Todo ─────────────────────────────────────────────

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  activeForm?: string;
}

export interface TodoState {
  todos: TodoItem[];
  summary?: {
    total: number;
    pending: number;
    in_progress: number;
    completed: number;
    cancelled: number;
  };
}

// ── ACP Session Events ───────────────────────────────

export interface BackgroundProcessState {
  id: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}

export interface DelegationRegistration {
  delegationId: string;
  transcriptPaths: string[];
}

export interface AutonomousTurnState {
  id: string;
  status: 'running' | 'completed' | 'failed';
  trigger: 'background_notification';
}

export interface SessionUpdateEvent {
  session_id: string;
  runtimeGeneration?: number;
  text?: string;
  replay?: boolean;
  background?: boolean;
  backgroundProcess?: BackgroundProcessState;
  autonomousTurn?: AutonomousTurnState;
  autonomousTurnId?: string;
  thinkingText?: string;
  toolTitle?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolKind?: string;
  toolLocations?: string[];
  todoState?: TodoState;
  done?: boolean;
  error?: string;
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
  cachedTokens?: number;
  compressionCount?: number;
  availableCommands?: AvailableSlashCommand[];
  agentActivities?: AgentActivity[];
  delegationRegistration?: DelegationRegistration;
}

export type SessionUpdateHandler = (event: SessionUpdateEvent) => void;

// ── Webview Messages ─────────────────────────────────

export interface ToWebview {
  type:
    | 'append' | 'backgroundNotification' | 'thinking' | 'toolCall' | 'done'
    | 'error' | 'status' | 'notice' | 'clear' | 'busy' | 'queueState'
    | 'statusBar' | 'sessionList' | 'loadHistory' | 'profileList' | 'remoteAuthState' | 'settingsState';
  text?: string;
  toolName?: string;
  toolStatus?: string;
  toolCallId?: string;
  toolDetail?: string;
  toolKind?: string;
  toolLocations?: string[];
  todoState?: TodoState;
  backgroundProcesses?: BackgroundProcessState[];
  status?: string;
  active?: boolean;
  queued?: number;
  queuedItems?: QueuedWebviewMessage[];
  startedText?: string;
  startedSlashCommand?: boolean;
  startedRequestId?: string;
  activeSlashCommand?: boolean;
  model?: string;
  sessionTitle?: string;
  contextUsed?: number;
  contextSize?: number;
  cachedTokens?: number;
  compressionCount?: number;
  version?: string;
  sessions?: ChatSession[];
  activeSessionId?: string;
  history?: StoredMessage[];
  switched?: boolean;
  attachedFiles?: { name: string; path: string }[];
  selectedSkills?: string[];
  skillGroups?: SkillGroup[];
  contextAnnotation?: string;
  profile?: string;
  profiles?: string[];
  profileItems?: ProfileMenuItem[];
  restartRequired?: boolean;
  availableCommands?: AvailableSlashCommand[];
  agentActivities?: AgentActivity[];
  // Remote control (RIA Atendimento) — SPEC_HERMES_INTEGRADO_RIA_ATENDIMENTO.md
  // seção 7.2: só rendered quando hermesRangelTech.remote.baseUrl está
  // configurado; a maioria dos usuários nunca vê isso.
  remoteConfigured?: boolean;
  remotePaired?: boolean;
  remoteDeviceName?: string;
  remoteBusy?: boolean;
  remoteError?: string;
  // Settings screen (SPEC_HERMES_INTEGRADO_RIA_ATENDIMENTO.md seção 7.5) —
  // the gear icon in the panel header. Provider fields never carry the
  // stored API key back to the webview, only whether one is set.
  settingsProviderName?: string;
  settingsProviderBaseUrl?: string;
  settingsProviderModel?: string;
  settingsProviderHasKey?: boolean;
  settingsBusy?: boolean;
  settingsError?: string;
  settingsTestOk?: boolean;
  settingsTestSummary?: string;
  settingsSaved?: boolean;
}

export interface FromWebview {
  type:
    | 'ready' | 'send' | 'editQueuedMessage' | 'deleteQueuedMessage' | 'switchModel' | 'cancel'
    | 'newSession' | 'switchSession'
    | 'attachFile' | 'pasteImage' | 'dropFiles' | 'clearAttachments'
    | 'toggleSkill' | 'renameSession' | 'deleteSession'
    | 'selectProfile' | 'customProfile' | 'restartHermes' | 'requestCommands'
    | 'remoteLogin' | 'remoteLogout'
    | 'settingsOpen' | 'settingsSaveProvider' | 'settingsTestProvider';
  text?: string;
  requestId?: string;
  sessionId?: string;
  model?: string;
  data?: string;
  ext?: string;
  uris?: string[];
  providerName?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerApiKey?: string;
  providerAllowInsecureHttp?: boolean;
}

// ── Attachment ───────────────────────────────────────

export interface AttachedFile {
  name: string;
  path: string;
}
