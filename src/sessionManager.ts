/**
 * Manages a single active ACP session.
 *
 * ACP method names (v1 protocol):
 *   session/new     — create session, returns { sessionId, models?, ... }
 *   session/prompt  — send message, blocks until done, params { sessionId, prompt: [...] }
 *   session/cancel  — abort (notification, no response), params { sessionId }
 *
 * Incoming notifications from agent:
 *   session/update  — { sessionId, update: { sessionUpdate, ... } }
 *     update kinds handled:
 *       agent_message_chunk  — streaming text delta
 *       agent_thought_chunk  — thinking text
 *       tool_call            — tool progress
 *       usage_update         — context used/size tokens
 *       session_info_update  — session title
 *
 * Incoming requests from agent:
 *   session/request_permission — auto-approved with allow_once
 *
 * Deduplication:
 *   Hermes ACP sends text as streaming deltas AND then resends the full
 *   accumulated text at the end as a reliability fallback. We track the
 *   accumulated text and drop the final repeated message.
 */

import { AcpClient } from './acpClient';
import { EditApprovalModeId, normalizeEditApprovalMode } from './editApprovalMode';
import type { SessionUpdateEvent, SessionUpdateHandler } from './types';
import {
  extractTextContent, deduplicateChunk,
  parseToolCall, parseToolCallUpdate,
  parseUsageUpdate, parseSessionInfoUpdate, parseBackgroundProcessMeta, parseAutonomousTurnMeta,
  parseCompressionCount,
} from './protocol';
import { parseAgentActivities } from './agentActivity';
import { parseAvailableCommandsUpdate } from './slashCommands';
import { parseDelegateTaskRegistration } from './delegationActivityMonitor';

export type PermissionRequestHandler = (method: string, params: unknown) => Promise<unknown>;

interface PromptTurn {
  id: number;
  sessionId: string | null;
  cancelled: boolean;
  promptActive: boolean;
}

export class SessionManager {
  private sessionId: string | null = null;
  /** Broadcast to every registered observer — the webview and, when paired,
   * the Hermes remote-control publisher (docs in `remoteControl.ts`) both
   * listen independently. */
  private readonly updateHandlers: SessionUpdateHandler[] = [];

  /** Accumulated streaming text per ACP session (used for resend dedup). */
  private readonly accumulatedBySession = new Map<string, string>();

  /** Cancellation ownership for the one active turn, including session binding. */
  private activePromptTurn: PromptTurn | null = null;
  private readonly autonomousTurnsBySession = new Map<string, string>();
  private readonly delegateToolCalls = new Set<string>();
  private nextPromptTurnId = 1;

  /** Session/generation currently replaying persisted history during session/load. */
  private replayBinding: { sessionId: string; generation: number } | undefined;
  private sessionBinding: Promise<string> | undefined;
  private bindingGeneration = 0;

  /** Preferred ACP edit mode, reapplied whenever a session is created or loaded. */
  private editApprovalMode: EditApprovalModeId;

  constructor(
    private readonly client: AcpClient,
    private readonly log: (line: string) => void = () => {},
    private readonly permissionRequestHandler?: PermissionRequestHandler,
    initialEditApprovalMode: EditApprovalModeId = 'default',
  ) {
    this.editApprovalMode = normalizeEditApprovalMode(initialEditApprovalMode);
    client.onNotification((method, params) => {
      if (method === 'session/update') {
        this.handleUpdate(params as Record<string, unknown>);
      }
    });

    client.onIncomingRequest(async (method, _params) => {
      if (method === 'session/request_permission') {
        if (!this.permissionRequestHandler) {
          throw new Error('Permission denied: no approval handler registered');
        }
        return this.permissionRequestHandler(method, _params);
      }
      throw new Error(`Unhandled client method: ${method}`);
    });

    // ACP session registrations belong to one child process generation. An
    // unexpected child exit makes the current ID resumable, not promptable,
    // until the replacement child receives session/load (or session/new).
    (client as unknown as {
      on?: (event: string, handler: (code: number) => void) => unknown;
    }).on?.('exit', () => this.handleClientExit());
  }

  onUpdate(handler: SessionUpdateHandler): void {
    this.updateHandlers.push(handler);
  }

  /** Set a stored ACP session ID for resume attempts. */
  setStoredSessionId(id: string | undefined): void {
    this.storedSessionId = id ?? null;
  }
  private storedSessionId: string | null = null;

  /** Returns the current ACP session ID (for persistence by the caller). */
  getSessionId(): string | null {
    return this.sessionId;
  }

  getRuntimeGeneration(): number {
    return this.bindingGeneration;
  }

  getEditApprovalMode(): EditApprovalModeId {
    return this.editApprovalMode;
  }

  async setEditApprovalMode(mode: EditApprovalModeId, cwd: string): Promise<void> {
    const previousMode = this.editApprovalMode;
    this.editApprovalMode = normalizeEditApprovalMode(mode);
    try {
      if (!this.sessionId) {
        await this.ensureSession(cwd);
        return;
      }
      await this.applyEditApprovalMode(this.sessionId);
    } catch (err) {
      this.editApprovalMode = previousMode;
      throw err;
    }
  }

  private async applyEditApprovalMode(sessionId: string): Promise<void> {
    await this.client.call('session/set_mode', {
      sessionId,
      modeId: this.editApprovalMode,
    });
    this.log(`[session] edit approval mode ${this.editApprovalMode}`);
  }

  async ensureSession(cwd: string): Promise<string> {
    if (this.sessionId) {
      this.log(`[session] reusing ${this.sessionId}`);
      return this.sessionId;
    }
    if (this.sessionBinding) return this.sessionBinding;

    const generation = this.bindingGeneration;
    const binding = this.bindSession(cwd, generation);
    this.sessionBinding = binding;
    try {
      return await binding;
    } finally {
      if (this.sessionBinding === binding) this.sessionBinding = undefined;
    }
  }

  private assertBindingCurrent(generation: number): void {
    if (generation !== this.bindingGeneration) throw new Error('Session binding superseded by reset');
  }

  private async bindSession(cwd: string, generation: number): Promise<string> {
    this.assertBindingCurrent(generation);
    if (this.sessionId) {
      this.log(`[session] reusing ${this.sessionId}`);
      return this.sessionId;
    }

    // Try to resume a stored session first.
    // Critical: we MUST call session/load so the adapter registers our session ID
    // in its in-memory map. Just assuming the ID is live (previous bug) creates a
    // phantom session that silently fails on subsequent session/prompt calls.
    if (this.storedSessionId) {
      const storedId = this.storedSessionId;
      this.storedSessionId = null;
      let loaded = false;
      const replayBinding = { sessionId: storedId, generation };
      try {
        this.log(`[session] attempting session/load ${storedId}`);
        // ACP requires history replay notifications before session/load returns.
        // Route those updates to the pending stored session, but keep them out
        // of the post-prompt background-notification path.
        this.sessionId = storedId;
        this.replayBinding = replayBinding;
        const result = await this.client.call('session/load', {
          sessionId: storedId,
          cwd,
          mcpServers: [],
        });
        this.assertBindingCurrent(generation);
        // Adapter returns null when session not found — load_session() → None
        if (result !== null && result !== undefined) {
          loaded = true;
          this.log(`[session] resumed ${storedId}`);
        } else {
          this.sessionId = null;
          this.log(`[session] stored session ${storedId} not found on adapter, creating new`);
        }
      } catch (err) {
        if (generation !== this.bindingGeneration) throw err;
        this.sessionId = null;
        this.log(`[session] session/load failed (${err}), creating new`);
      } finally {
        if (this.replayBinding === replayBinding) this.replayBinding = undefined;
      }
      if (loaded) {
        await this.applyEditApprovalMode(storedId);
        this.assertBindingCurrent(generation);
        return storedId;
      }
      // Fall through to session/new
    }

    this.log(`[session] creating new session for cwd=${cwd}`);

    const result = (await this.client.call('session/new', {
      cwd,
      mcpServers: [],
    })) as { sessionId: string; models?: { currentModelId?: string } };
    this.assertBindingCurrent(generation);

    this.sessionId = result.sessionId;
    this.log(`[session] created ${this.sessionId}`);
    await this.applyEditApprovalMode(this.sessionId);
    this.assertBindingCurrent(generation);

    // Emit initial model from session/new response
    const model = result.models?.currentModelId;
    if (model) {
      this.emit({ session_id: this.sessionId, model });
    }

    return this.sessionId;
  }

  async sendPrompt(
    text: string,
    cwd: string,
    onSessionBound?: (sessionId: string) => void,
    beforeSessionBinding?: () => Promise<void>,
  ): Promise<void> {
    if (this.activePromptTurn) throw new Error('Prompt already active');
    const turn: PromptTurn = {
      id: this.nextPromptTurnId++,
      sessionId: null,
      cancelled: false,
      promptActive: false,
    };
    this.activePromptTurn = turn;

    try {
      await beforeSessionBinding?.();
      if (turn.cancelled) throw new Error('Cancelled');
      const sessionId = await this.ensureSession(cwd);
      turn.sessionId = sessionId;
      this.accumulatedBySession.set(sessionId, '');
      onSessionBound?.(sessionId);
      if (turn.cancelled) throw new Error('Cancelled');
      this.log(`[session] prompt ${sessionId} (${text.length} chars)`);

      turn.promptActive = true;
      try {
        await this.client.call('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text }],
        });
      } catch (err) {
        if (turn.cancelled) throw new Error('Cancelled');
        throw err;
      }
      // A cancellation is complete only when the matching ACP request reaches a
      // terminal response. This barrier prevents the caller from draining its
      // next queued turn while the cancelled request is still live remotely.
      if (turn.cancelled) throw new Error('Cancelled');

      // PromptResponse usage is cumulative turn billing, not current context
      // pressure. Context metrics arrive authoritatively via usage_update.
      this.log(`[session] prompt done ${sessionId}`);
      this.emit({ session_id: sessionId, done: true });
    } finally {
      if (turn.sessionId) this.accumulatedBySession.delete(turn.sessionId);
      if (this.activePromptTurn === turn) this.activePromptTurn = null;
    }
  }

  async cancel(): Promise<void> {
    const turn = this.activePromptTurn;
    if (!turn) {
      if (this.sessionId && this.autonomousTurnsBySession.has(this.sessionId)) {
        this.log(`[session] cancel autonomous turn ${this.autonomousTurnsBySession.get(this.sessionId)}`);
        this.client.notify('session/cancel', { sessionId: this.sessionId });
        return;
      }
      this.log('[session] cancel requested with no active turn');
      return;
    }
    this.log(`[session] cancel requested turn ${turn.id}`);
    turn.cancelled = true;
    if (!turn.promptActive || !turn.sessionId) return;
    // session/cancel is a notification in ACP — no id, no response expected.
    // Binding-only cancellation is local because no session/prompt exists yet.
    // Once prompting starts, sendPrompt remains pending until that call terminates.
    this.client.notify('session/cancel', { sessionId: turn.sessionId });
  }

  private handleClientExit(): void {
    const resumableSessionId = this.sessionId;
    this.log(`[session] ACP child exited${resumableSessionId ? `; will reload ${resumableSessionId}` : ''}`);
    this.bindingGeneration += 1;
    this.sessionBinding = undefined;
    this.replayBinding = undefined;
    this.sessionId = null;
    if (resumableSessionId) this.storedSessionId = resumableSessionId;
    this.accumulatedBySession.clear();
    this.autonomousTurnsBySession.clear();
    this.delegateToolCalls.clear();
  }

  reset(): void {
    this.log('[session] reset');
    this.bindingGeneration += 1;
    this.sessionBinding = undefined;
    this.replayBinding = undefined;
    this.sessionId = null;
    this.storedSessionId = null;
    this.accumulatedBySession.clear();
    this.autonomousTurnsBySession.clear();
    this.delegateToolCalls.clear();
  }

  private handleUpdate(params: Record<string, unknown>): void {
    if (this.updateHandlers.length === 0) return;

    const session_id = params.sessionId as string;
    const update = params.update as Record<string, unknown> | undefined;
    if (!session_id || !update) return;
    const kind = update.sessionUpdate as string;
    const trackedAutonomousTurnId = this.autonomousTurnsBySession.get(session_id);
    if (session_id !== this.sessionId) {
      const meta = update['_meta'] as Record<string, unknown> | undefined;
      const hermesMeta = meta?.hermes as Record<string, unknown> | undefined;
      if (
        kind !== 'session_info_update'
        && hermesMeta?.backgroundNotification !== true
        && !trackedAutonomousTurnId
      ) {
        this.log(`[session] ignored update for inactive session ${session_id}`);
        return;
      }
    }

    const event: SessionUpdateEvent = {
      session_id,
      runtimeGeneration: this.bindingGeneration,
      replay: this.replayBinding?.sessionId === session_id,
    };
    const compressionCount = parseCompressionCount(update);
    if (compressionCount !== undefined) event.compressionCount = compressionCount;
    const agentActivities = parseAgentActivities(update);
    if (agentActivities !== null) event.agentActivities = agentActivities;
    const autonomousTurn = parseAutonomousTurnMeta(update);
    if (autonomousTurn) {
      event.autonomousTurn = autonomousTurn;
      if (autonomousTurn.status === 'running') {
        this.autonomousTurnsBySession.set(session_id, autonomousTurn.id);
        this.accumulatedBySession.set(session_id, '');
      }
    }
    const autonomousTurnId = autonomousTurn?.id ?? this.autonomousTurnsBySession.get(session_id);
    if (autonomousTurnId) event.autonomousTurnId = autonomousTurnId;

    switch (kind) {
      case 'agent_message_chunk': {
        if (this.activePromptTurn?.cancelled && this.activePromptTurn.sessionId === session_id) return;
        const text = extractTextContent(update);
        if (text === null) return;
        const meta = update['_meta'] as Record<string, unknown> | undefined;
        const hermesMeta = meta?.hermes as Record<string, unknown> | undefined;
        const isAutonomous = autonomousTurnId !== undefined;
        const isLifecycle = autonomousTurn !== undefined;
        const isBackground = (hermesMeta?.backgroundNotification === true && !isLifecycle)
          || (!(this.activePromptTurn?.promptActive ?? false)
            && !isAutonomous
            && this.replayBinding?.sessionId !== session_id);
        event.background = isBackground;
        event.backgroundProcess = parseBackgroundProcessMeta(update);
        if (isLifecycle && text === '') break;
        if (isBackground) {
          event.text = text;
          break;
        }
        const accumulated = this.accumulatedBySession.get(session_id) ?? '';
        const result = deduplicateChunk(text, accumulated);
        if (result.action === 'drop') {
          if (accumulated.endsWith(text)) {
            this.log(`[session] dedup: dropped partial resend (${text.length} chars)`);
          }
          return;
        }
        this.accumulatedBySession.set(session_id, result.newAccumulated);
        event.text = result.text;
        break;
      }

      case 'agent_thought_chunk': {
        if (this.activePromptTurn?.cancelled && this.activePromptTurn.sessionId === session_id) return;
        const text = extractTextContent(update);
        if (text?.trim()) event.thinkingText = text;
        else return;
        break;
      }

      case 'tool_call': {
        if (this.activePromptTurn?.cancelled && this.activePromptTurn.sessionId === session_id) return;
        const parsed = parseToolCall(update);
        event.toolTitle = parsed.title;
        event.toolStatus = parsed.status;
        event.toolCallId = parsed.toolCallId;
        event.toolKind = parsed.kind;
        if (parsed.toolCallId && (
          parsed.title === 'delegate task'
          || parsed.title.startsWith('delegate:')
          || parsed.title.startsWith('delegate batch (')
        )) {
          this.delegateToolCalls.add(`${session_id}\0${parsed.toolCallId}`);
        }
        if (parsed.locations.length) event.toolLocations = parsed.locations;
        if (parsed.detail) event.toolDetail = parsed.detail;
        if (parsed.todoState) {
          event.todoState = parsed.todoState;
          this.log(`[session] todo tool_call: ${parsed.todoState.todos.length} items`);
        }
        break;
      }

      case 'tool_call_update': {
        const cancelledOwner = this.activePromptTurn?.cancelled === true
          && this.activePromptTurn.sessionId === session_id;
        const parsed = parseToolCallUpdate(update);
        event.toolCallId = parsed.toolCallId;
        event.toolStatus = parsed.status;
        event.toolTitle = ''; // signal: update, not new call
        const delegationKey = parsed.toolCallId ? `${session_id}\0${parsed.toolCallId}` : '';
        if (delegationKey && this.delegateToolCalls.has(delegationKey)) {
          if (parsed.status === 'completed') {
            event.delegationRegistration = parseDelegateTaskRegistration(update);
          }
          if (parsed.status !== 'running' && parsed.status !== 'pending') {
            this.delegateToolCalls.delete(delegationKey);
          }
        }
        if (cancelledOwner && !event.delegationRegistration) return;
        if (parsed.backgroundProcess) event.backgroundProcess = parsed.backgroundProcess;
        if (parsed.todoState) {
          event.todoState = parsed.todoState;
          this.log(`[session] todo update: ${parsed.todoState.todos.length} items`);
        }
        break;
      }

      case 'usage_update': {
        const usage = parseUsageUpdate(update);
        if (usage) {
          event.contextUsed = usage.contextUsed;
          event.contextSize = usage.contextSize;
        } else if (!event.agentActivities && event.compressionCount === undefined) return;
        break;
      }

      case 'session_info_update': {
        const title = parseSessionInfoUpdate(update);
        if (title) event.sessionTitle = title;
        else if (!event.agentActivities && event.compressionCount === undefined) return;
        break;
      }

      case 'available_commands_update': {
        const availableCommands = parseAvailableCommandsUpdate(update);
        if (availableCommands === null) return;
        event.availableCommands = availableCommands;
        break;
      }

      default:
        if (!event.agentActivities && !event.autonomousTurn && event.compressionCount === undefined) return;
    }

    if (autonomousTurn && autonomousTurn.status !== 'running') {
      this.autonomousTurnsBySession.delete(session_id);
      this.accumulatedBySession.delete(session_id);
    }

    this.emit(event);
  }

  private emit(event: SessionUpdateEvent): void {
    for (const handler of this.updateHandlers) handler(event);
  }
}
