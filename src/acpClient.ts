/**
 * ACP (Agent Client Protocol) client.
 * Speaks JSON-RPC 2.0 over a `hermes acp` stdio subprocess.
 *
 * Wire format: newline-delimited JSON
 * Method names: slash-delimited (session/new, session/prompt, …)
 * Params/result fields: camelCase aliases from the Pydantic schema
 *
 * Incoming message types:
 *   - Response to our request     → { jsonrpc, id, result|error }
 *   - Notification from agent     → { jsonrpc, method, params }   (no id)
 *   - Request from agent to us    → { jsonrpc, id, method, params }  (we must reply)
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { buildHermesAcpArgs, normalizeHermesProfile } from './acpLaunchArgs';
import { killProcessTree } from './runtime/process';

export type IncomingRequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown>;

export type NotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

export class AcpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private buffer = '';
  private notificationHandler: NotificationHandler | null = null;
  private requestHandler: IncomingRequestHandler | null = null;

  private profile = '';
  private activeProfile = '';

  constructor(
    private hermesPath: string,
    /** Overrides merged into process.env, or a function returning the complete child environment. */
    private readonly envOverrides: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = {},
    private readonly debugLogging = false,
    profile = '',
  ) {
    super();
    this.profile = normalizeHermesProfile(profile);
  }

  setHermesPath(nextPath: string): void {
    if (this.proc) return;
    this.hermesPath = nextPath;
  }

  /** Fixed launch arguments from a managed runtime. Null keeps the default `[--profile p] acp`. */
  private launchArgs: string[] | null = null;

  setLaunchArgs(args: string[] | null): void {
    if (this.proc) return;
    this.launchArgs = args;
  }

  private terminate(proc: ChildProcess): void {
    // On Windows a plain kill ends only the interpreter; the shell and tool processes it started would survive.
    if (process.platform === 'win32') killProcessTree(proc.pid);
    proc.kill();
  }

  setProfile(nextProfile: string): void {
    this.profile = normalizeHermesProfile(nextProfile);
  }

  get selectedProfile(): string {
    return this.profile;
  }

  get launchedProfile(): string {
    return this.activeProfile;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  /** Handle requests sent FROM the agent TO us (e.g. session/request_permission). */
  onIncomingRequest(handler: IncomingRequestHandler): void {
    this.requestHandler = handler;
  }

  get running(): boolean {
    return this.proc !== null;
  }

  async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.proc) return;

    const startPromise = this.startProcess();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    const args = this.launchArgs ?? buildHermesAcpArgs(this.profile);
    this.activeProfile = this.profile;
    this.emit('log', `[acp] spawn ${this.hermesPath} ${args.join(' ')}`);
    const proc = spawn(this.hermesPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: typeof this.envOverrides === 'function' ? this.envOverrides() : { ...process.env, ...this.envOverrides },
    });
    this.proc = proc;

    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => {
      if (this.proc === proc) this.onData(chunk, proc);
    });

    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (line: string) => {
      if (this.proc === proc) this.emit('log', line.trimEnd());
    });

    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this.emit('log', `[acp] spawn error: ${err.message}`);
      this.proc = null;
      this.startPromise = null;
      this.buffer = '';
      this.rejectPending(new Error(`Failed to start hermes: ${err.message}`));
      this.emit('exit', -1);
    });

    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.startPromise = null;
      this.buffer = '';
      this.rejectPending(new Error(`hermes acp exited (code ${code})`));
      this.emit('exit', code);
    });

    // Handshake — protocolVersion is integer 1, params use camelCase
    try {
      await this.call('initialize', { protocolVersion: 1 });
    } catch (err) {
      if (this.proc === proc) {
        this.proc = null;
        this.startPromise = null;
        this.buffer = '';
        this.rejectPending(err instanceof Error ? err : new Error(String(err)));
        this.terminate(proc);
        this.emit('exit', -1);
      }
      throw err;
    }
  }

  stop(): void {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    this.startPromise = null;
    this.buffer = '';
    this.rejectPending(new Error('hermes acp stopped'));
    this.terminate(proc);
  }

  async call(method: string, params: unknown): Promise<unknown> {
    if (!this.proc) throw new Error('ACP client not started');

    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    this.emit('log', this.debugLogging
      ? `[acp] --> ${method} #${id} ${this.preview(params)}`
      : `[acp] --> ${method} #${id}`);

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc!.stdin!.write(message);
    });
  }

  /** Send a fire-and-forget notification (no id, no response expected). */
  notify(method: string, params: unknown): void {
    if (!this.proc) return;
    const message = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.emit('log', this.debugLogging
      ? `[acp] ~~> ${method} ${this.preview(params)}`
      : `[acp] ~~> ${method}`);
    this.proc.stdin!.write(message);
  }

  private reply(proc: ChildProcess, id: number | string, result: unknown): void {
    if (this.proc !== proc) return;
    const message = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
    proc.stdin?.write(message);
  }

  private replyError(proc: ChildProcess, id: number | string, code: number, message: string): void {
    if (this.proc !== proc) return;
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }) + '\n';
    proc.stdin?.write(payload);
  }

  private onData(chunk: string, proc: ChildProcess): void {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (this.debugLogging) {
        this.emit('log', `[acp raw] ${trimmed.slice(0, 500)}`);
      }
      try {
        this.dispatch(JSON.parse(trimmed), proc);
      } catch {
        this.emit('log', '[acp] failed to parse JSON line');
        // Ignore malformed lines
      }
    }
  }

  private dispatch(msg: Record<string, unknown>, proc: ChildProcess): void {
    if (msg.id !== undefined && msg.method) {
      // Incoming request from agent (e.g. session/request_permission)
      this.handleIncomingRequest(msg, proc);
    } else if (msg.id !== undefined) {
      // Response to one of our call()s
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);

      if (msg.error) {
        const err = msg.error as { message: string; code: number };
        this.emit('log', `[acp] <-- #${msg.id} ERROR ${err.code}: ${err.message}`);
        pending.reject(new Error(`ACP error ${err.code}: ${err.message}`));
      } else {
        this.emit('log', this.debugLogging
          ? `[acp] <-- #${msg.id} OK ${this.preview(msg.result)}`
          : `[acp] <-- #${msg.id} OK`);
        pending.resolve(msg.result);
      }
    } else if (msg.method) {
      // Notification (no id)
      this.emit('log', this.debugLogging
        ? `[acp] <-- ${msg.method} ${this.preview(msg.params)}`
        : `[acp] <-- ${msg.method}`);
      this.notificationHandler?.(msg.method as string, msg.params);
    }
  }

  private preview(value: unknown): string {
    try {
      const text = JSON.stringify(value);
      if (!text) return '';
      return text.length > 400 ? `${text.slice(0, 400)}…` : text;
    } catch {
      return '[unserializable]';
    }
  }

  private rejectPending(error: Error): void {
    for (const [, request] of this.pending) request.reject(error);
    this.pending.clear();
  }

  private handleIncomingRequest(msg: Record<string, unknown>, proc: ChildProcess): void {
    const id = msg.id as number | string;
    const method = msg.method as string;
    const params = msg.params;

    if (this.requestHandler) {
      this.requestHandler(method, params)
        .then((result) => this.reply(proc, id, result))
        .catch((err: Error) => this.replyError(proc, id, -32603, err.message));
    } else {
      this.replyError(proc, id, -32601, `No handler for ${method}`);
    }
  }
}
