/**
 * Hermes remote control (RIA Atendimento): pareia este computador com o
 * backend do Agent LLM, publica sessões/eventos e consome comandos remotos,
 * injetando-os na sessão Hermes local exatamente como se o usuário tivesse
 * digitado no próprio VS Code (ver docs/specs/SPEC_HERMES_INTEGRADO_RIA_ATENDIMENTO.md
 * no repo agent-platform).
 *
 * Transporte: HTTP curto (poll de `/api/hermes/commands/pending`), não o
 * WebSocket Relay da seção 8.1 da spec — decisão deliberada, registrada em
 * docs/remote-control.md: o contrato idempotente da Fase A não muda quando o
 * Relay chegar, só o transporte melhora de segundos para tempo real.
 */

import * as os from 'os';
import * as vscode from 'vscode';
import type { SessionManager } from './sessionManager';
import type { SessionUpdateEvent } from './types';

const NS = 'hermesRangelTech';
const CREDENTIAL_KEY = 'hermesRangelTech/remote/deviceCredential';
const STATE_KEY = 'hermesRangelTech.remoteDevice';
const POLL_INTERVAL_MS = 4000;

export interface PairedDevice {
  id: string;
  tenantId: string;
  name: string;
}

export interface RemoteSessionInfo {
  externalSessionId: string;
  workspacePath: string;
  providerName?: string;
  modelName?: string;
}

function baseUrl(): string {
  return (vscode.workspace.getConfiguration(NS).get<string>('remote.baseUrl') || '').replace(/\/+$/, '');
}

function computerName(): string {
  const override = vscode.workspace.getConfiguration(NS).get<string>('remote.deviceName');
  return (override && override.trim()) || os.hostname();
}

async function api(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<Response> {
  const url = baseUrl();
  if (!url) throw new Error('Configure hermesRangelTech.remote.baseUrl antes de usar o remote control.');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${url}${path}`, {
    method: init.method ?? 'GET',
    body: init.body,
    headers,
    signal: AbortSignal.timeout(15000),
  });
  return res;
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export class RemoteControlError extends Error {}

/** Pairs this computer using the same email/password as the RIA web login
 * (seção 7.2). Never persists the password — only the device credential
 * that comes back is stored, in VS Code Secret Storage. */
export async function pairDevice(
  context: vscode.ExtensionContext,
  email: string,
  password: string,
): Promise<PairedDevice> {
  const name = computerName();
  const res = await api('/api/hermes/devices/pair', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      device_name: name,
      platform: process.platform,
      extension_version: String(context.extension.packageJSON.version ?? ''),
    }),
  });
  const body = (await readJson(res)) as { device?: Record<string, unknown>; credential?: string; detail?: string };
  if (!res.ok || !body?.credential || !body.device) {
    throw new RemoteControlError(body?.detail || `Falha ao parear (HTTP ${res.status}).`);
  }
  await context.secrets.store(CREDENTIAL_KEY, body.credential);
  const device: PairedDevice = {
    id: String(body.device.id),
    tenantId: String(body.device.tenant_id),
    name: String(body.device.name),
  };
  await context.globalState.update(STATE_KEY, device);
  return device;
}

export async function pairedDevice(context: vscode.ExtensionContext): Promise<PairedDevice | undefined> {
  const device = context.globalState.get<PairedDevice>(STATE_KEY);
  const credential = await context.secrets.get(CREDENTIAL_KEY);
  return device && credential ? device : undefined;
}

export async function unpairDevice(context: vscode.ExtensionContext): Promise<void> {
  const device = context.globalState.get<PairedDevice>(STATE_KEY);
  const credential = await context.secrets.get(CREDENTIAL_KEY);
  if (device && credential) {
    try {
      await api(`/api/hermes/devices/${device.id}/revoke`, { method: 'POST', token: credential });
    } catch {
      // Best effort: the local credential is discarded either way.
    }
  }
  await context.secrets.delete(CREDENTIAL_KEY);
  await context.globalState.update(STATE_KEY, undefined);
}

interface PendingCommand {
  id: string;
  session_id: string;
  payload: { text?: string };
}

/**
 * Keeps one local Hermes session published to the RIA and forwards remote
 * commands into it. One instance per extension activation; `attach` is
 * called once the local session/workspace is known.
 */
export class RemoteSessionPublisher implements vscode.Disposable {
  private credential: string | null = null;
  private sequence = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private info: RemoteSessionInfo | null = null;
  private remoteSessionId: string | null = null;
  private inFlightCommandIds = new Set<string>();
  private pendingTurnDone: Array<() => void> = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly session: SessionManager,
    private readonly log: (line: string) => void,
    /** Sends text into the local Hermes session, same path as a typed message. */
    private readonly sendLocalPrompt: (text: string) => Promise<void>,
  ) {
    this.session.onUpdate((event) => { void this.onLocalUpdate(event); });
  }

  async refreshCredential(): Promise<boolean> {
    this.credential = (await this.context.secrets.get(CREDENTIAL_KEY)) ?? null;
    return this.credential !== null;
  }

  /** Registers (or updates) the session that should be visible remotely. */
  async attach(info: RemoteSessionInfo): Promise<void> {
    this.info = info;
    if (!(await this.refreshCredential())) return;
    await this.upsert('idle');
    this.startPolling();
  }

  detach(): void {
    this.stopPolling();
    this.info = null;
    this.remoteSessionId = null;
  }

  dispose(): void {
    this.stopPolling();
  }

  private async upsert(status: string): Promise<void> {
    if (!this.info || !this.credential) return;
    try {
      const res = await api('/api/hermes/sessions', {
        method: 'POST',
        token: this.credential,
        body: JSON.stringify({
          external_session_id: this.info.externalSessionId,
          title: this.info.externalSessionId,
          workspace_path: this.info.workspacePath,
          provider_name: this.info.providerName,
          model_name: this.info.modelName,
          status,
        }),
      });
      const body = (await readJson(res)) as { id?: string };
      if (res.ok && body?.id) {
        this.remoteSessionId = body.id;
      } else {
        this.log(`[remote] session upsert failed: HTTP ${res.status}`);
      }
    } catch (err) {
      this.log(`[remote] session upsert error: ${err}`);
    }
  }

  private async publish(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.remoteSessionId || !this.credential) return;
    const sequence = this.sequence++;
    try {
      await api(`/api/hermes/sessions/${this.remoteSessionId}/events`, {
        method: 'POST',
        token: this.credential,
        body: JSON.stringify({ sequence, type, payload }),
      });
    } catch (err) {
      this.log(`[remote] event publish error: ${err}`);
    }
  }

  private async onLocalUpdate(event: SessionUpdateEvent): Promise<void> {
    if (!this.remoteSessionId) return;
    if (event.text) await this.publish('agent_message_chunk', { text: event.text });
    if (event.toolTitle) {
      await this.publish('tool_call', { title: event.toolTitle, status: event.toolStatus, kind: event.toolKind });
    }
    if (event.error) await this.publish('error', { message: event.error });
    if (event.done) {
      await this.publish('done', {});
      await this.upsert('idle');
      const resolvers = this.pendingTurnDone;
      this.pendingTurnDone = [];
      for (const resolve of resolvers) resolve();
    }
  }

  /** Resolves on the next `done` from the local session — `sendLocalPrompt`
   * itself may return as soon as the message is queued, not when the turn
   * actually finishes (e.g. a busy panel). This is the real completion
   * signal, independent of that detail. */
  private waitForNextTurnDone(timeoutMs = 15 * 60 * 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTurnDone = this.pendingTurnDone.filter(r => r !== onDone);
        reject(new Error('Timed out waiting for the Hermes turn to finish.'));
      }, timeoutMs);
      const onDone = (): void => { clearTimeout(timer); resolve(); };
      this.pendingTurnDone.push(onDone);
    });
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => { void this.pollOnce(); }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.credential) return;
    let commands: PendingCommand[];
    try {
      const res = await api('/api/hermes/commands/pending', { token: this.credential });
      if (!res.ok) return;
      commands = ((await readJson(res)) as PendingCommand[]) ?? [];
    } catch (err) {
      this.log(`[remote] poll error: ${err}`);
      return;
    }
    for (const command of commands) {
      if (command.session_id !== this.remoteSessionId) continue; // not for this local session
      if (this.inFlightCommandIds.has(command.id)) continue;
      this.inFlightCommandIds.add(command.id);
      void this.runCommand(command);
    }
  }

  private async transition(commandId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.credential) return;
    try {
      await api(`/api/hermes/commands/${commandId}/transition`, {
        method: 'POST',
        token: this.credential,
        body: JSON.stringify({ status, ...extra }),
      });
    } catch (err) {
      this.log(`[remote] transition error: ${err}`);
    }
  }

  private async runCommand(command: PendingCommand): Promise<void> {
    const text = command.payload?.text;
    if (!text) {
      await this.transition(command.id, 'rejected', { error: 'Comando sem texto de instrução.' });
      this.inFlightCommandIds.delete(command.id);
      return;
    }
    this.log(`[remote] executando comando ${command.id}`);
    await this.transition(command.id, 'accepted');
    await this.upsert('running');
    await this.transition(command.id, 'running');
    try {
      const done = this.waitForNextTurnDone();
      await this.sendLocalPrompt(text);
      await done;
      await this.transition(command.id, 'completed', { result: { ok: true } });
    } catch (err) {
      await this.transition(command.id, 'failed', { error: String(err) });
    } finally {
      await this.upsert('idle');
      this.inFlightCommandIds.delete(command.id);
    }
  }
}
