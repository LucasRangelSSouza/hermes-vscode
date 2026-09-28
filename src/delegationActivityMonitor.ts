import { constants, readFileSync } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentActivity } from './agentActivity';
import type { DelegationRegistration } from './types';
import { activeHermesHomeOrNull } from './paths/hermesHome';
export type { DelegationRegistration } from './types';

export interface DelegationActivityScope {
  sessionId: string;
  generation: number;
  registrations: DelegationRegistration[];
}

interface ParsedDelegation {
  activities: AgentActivity[];
}

const DELEGATION_ID = /^deleg_[a-f0-9]{8}$/;
const TASK_LOG = /^task-(\d+)\.log$/;
// A producer-valid batch can contain 100 redacted goals of 500 Unicode
// characters plus absolute transcript paths and JSON framing. One MiB covers
// that exact envelope while retaining a strict bounded read.
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_COMPLETION_BYTES = 128 * 1024;
const MAX_DELEGATIONS = 20;
const MAX_TASKS = 100;
const MAX_DISPATCH_TASKS = MAX_TASKS;
const MAX_GOAL_LENGTH = 500;
const MAX_TRANSCRIPT_PATH_LENGTH = 4_096;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseJsonRecord(value: unknown): Record<string, unknown> | undefined {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== 'string' || value.length > MAX_COMPLETION_BYTES) return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function completionRecords(update: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const raw = parseJsonRecord(update.rawOutput ?? update.raw_output);
  if (raw) records.push(raw);

  const content = update.content;
  if (!Array.isArray(content)) return records;
  for (const block of content) {
    const outer = record(block);
    if (!outer) continue;
    const inner = record(outer.content);
    const text = typeof inner?.text === 'string'
      ? inner.text
      : typeof outer.text === 'string'
        ? outer.text
        : undefined;
    const parsed = parseJsonRecord(text);
    if (parsed) records.push(parsed);
  }
  return records;
}

function registrationFromParts(
  delegationId: unknown,
  count: unknown,
  rawTranscriptPaths: unknown,
): DelegationRegistration | undefined {
  if (typeof delegationId !== 'string' || !DELEGATION_ID.test(delegationId)) return undefined;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_DISPATCH_TASKS) return undefined;
  if (!Array.isArray(rawTranscriptPaths) || rawTranscriptPaths.length !== count) return undefined;
  const transcriptPaths = rawTranscriptPaths.filter((item): item is string => typeof item === 'string');
  if (transcriptPaths.length !== rawTranscriptPaths.length) return undefined;
  const delegationDirectory = path.dirname(transcriptPaths[0]);
  const valid = transcriptPaths.every((transcriptPath, index) => {
    const match = TASK_LOG.exec(path.basename(transcriptPath));
    return path.isAbsolute(transcriptPath)
      && transcriptPath.length <= MAX_TRANSCRIPT_PATH_LENGTH
      && path.dirname(transcriptPath) === delegationDirectory
      && path.basename(delegationDirectory) === delegationId
      && match !== null
      && Number(match[1]) === index;
  });
  return valid ? { delegationId, transcriptPaths } : undefined;
}

/** Parse the structured completion of a confirmed delegate_task tool call. */
export function parseDelegateTaskRegistration(
  update: Record<string, unknown>,
): DelegationRegistration | undefined {
  const meta = record(update._meta);
  const hermes = record(meta?.hermes);
  if (hermes && Object.prototype.hasOwnProperty.call(hermes, 'delegateTask')) {
    const delegateTask = record(hermes.delegateTask);
    if (!delegateTask
      || delegateTask.schemaVersion !== 1
      || delegateTask.status !== 'dispatched') return undefined;
    return registrationFromParts(
      delegateTask.delegationId,
      delegateTask.taskCount,
      delegateTask.liveTranscripts,
    );
  }

  for (const data of completionRecords(update)) {
    if (data.status !== 'dispatched') continue;
    const count = data.count;
    if (!Array.isArray(data.goals) || data.goals.length !== count
      || !data.goals.every(goal => typeof goal === 'string')) continue;
    const registration = registrationFromParts(data.delegation_id, count, data.live_transcripts);
    if (registration) return registration;
  }
  return undefined;
}

async function readBoundedJson(manifestPath: string, canonicalDirectory: string): Promise<unknown> {
  const lexical = await lstat(manifestPath);
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error('delegation manifest is not a regular file');
  const canonicalManifest = await realpath(manifestPath);
  if (canonicalManifest !== path.join(canonicalDirectory, 'manifest.json')) {
    throw new Error('delegation manifest escaped its directory');
  }
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(manifestPath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error('delegation manifest is not a regular file');
    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error('delegation manifest exceeds size limit');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

function allowedDelegationDirectory(relative: string, delegationId: string): boolean {
  const segments = relative.split(path.sep);
  const current = segments.length === 4
    && segments[0] === 'cache'
    && segments[1] === 'delegation'
    && segments[2] === 'live'
    && segments[3] === delegationId;
  const legacy = segments.length === 3
    && segments[0] === 'delegation_cache'
    && segments[1] === 'live'
    && segments[2] === delegationId;
  return current || legacy;
}

function displayGoal(goal: string, index: number): string {
  const normal = goal.replace(/\s+/g, ' ').trim();
  const fallback = `task ${index + 1}`;
  const label = normal || fallback;
  type GraphemeSegmenter = {
    segment(input: string): Iterable<{ segment: string }>;
  };
  type GraphemeSegmenterConstructor = new (
    locales?: string | string[],
    options?: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
  const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }).Segmenter;
  const units = Segmenter
    ? Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(label), ({ segment }) => segment)
    : Array.from(label);
  const truncated = units.length > 60 ? `${units.slice(0, 57).join('')}...` : label;
  return `Delegate · ${truncated}`;
}

async function parseDelegation(
  hermesHome: string,
  registration: DelegationRegistration,
): Promise<ParsedDelegation | undefined> {
  if (!DELEGATION_ID.test(registration.delegationId)
    || registration.transcriptPaths.length === 0
    || registration.transcriptPaths.length > MAX_TASKS) return undefined;

  const lexicalDirectory = path.dirname(registration.transcriptPaths[0]);
  if (!registration.transcriptPaths.every((transcriptPath, index) => {
    const match = TASK_LOG.exec(path.basename(transcriptPath));
    return path.dirname(transcriptPath) === lexicalDirectory
      && match !== null
      && Number(match[1]) === index;
  })) return undefined;

  const [canonicalHome, canonicalDirectory] = await Promise.all([
    realpath(hermesHome),
    realpath(lexicalDirectory),
  ]);
  const relative = path.relative(canonicalHome, canonicalDirectory);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    || !allowedDelegationDirectory(relative, registration.delegationId)) return undefined;

  const data = record(await readBoundedJson(path.join(canonicalDirectory, 'manifest.json'), canonicalDirectory));
  if (!data || data.delegation_id !== registration.delegationId
    || !Number.isInteger(data.task_count)
    || (data.task_count as number) < 1
    || (data.task_count as number) > MAX_TASKS
    || data.task_count !== registration.transcriptPaths.length
    || !Array.isArray(data.tasks)
    || data.tasks.length !== data.task_count) return undefined;

  const activities: AgentActivity[] = [];
  const seen = new Set<number>();
  for (const item of data.tasks) {
    const task = record(item);
    const index = task?.index;
    const goal = task?.goal;
    const status = task?.status;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= registration.transcriptPaths.length
      || seen.has(index as number)
      || typeof goal !== 'string' || Array.from(goal).length > MAX_GOAL_LENGTH
      || typeof status !== 'string') return undefined;
    seen.add(index as number);
    if (status !== 'running' && status !== 'starting') continue;
    activities.push({
      id: `delegate-task:${registration.delegationId}:${index}`,
      name: displayGoal(goal, index as number),
      status: status === 'starting' ? 'starting' : 'running',
    });
  }
  return { activities };
}

/** Load active tasks only from delegations registered by the current ACP session. */
export async function loadDelegationActivities(
  hermesHome: string,
  registrations: readonly DelegationRegistration[],
): Promise<AgentActivity[]> {
  let canonicalHome: string;
  try {
    canonicalHome = await realpath(hermesHome);
  } catch {
    return [];
  }

  const activities: AgentActivity[] = [];
  for (const registration of registrations.slice(0, MAX_DELEGATIONS)) {
    try {
      const parsed = await parseDelegation(canonicalHome, registration);
      if (parsed) activities.push(...parsed.activities);
    } catch {
      // Delegation telemetry is optional and fail-closed.
    }
  }
  return activities.slice(0, MAX_TASKS);
}

export function defaultHermesHome(): string {
  const active = activeHermesHomeOrNull();
  if (active) return active;
  const configured = process.env.HERMES_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.hermes');
}

const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Mirror Hermes CLI profile-home resolution without trusting workspace input. */
export function resolveHermesHomeForProfile(
  profile: string | undefined | null,
  configuredHome = defaultHermesHome(),
): string {
  const home = path.resolve(configuredHome);
  const configuredProfileHome = path.basename(path.dirname(home)) === 'profiles';
  const root = configuredProfileHome ? path.dirname(path.dirname(home)) : home;
  const requested = (profile ?? '').trim();

  if (requested) {
    if (!PROFILE_ID.test(requested)) return root;
    return requested === 'default' ? root : path.join(root, 'profiles', requested);
  }
  if (configuredProfileHome) return home;

  try {
    const active = readFileSync(path.join(root, 'active_profile'), 'utf8').trim();
    if (active && active !== 'default' && PROFILE_ID.test(active)) {
      return path.join(root, 'profiles', active);
    }
  } catch {
    // Missing or unreadable active-profile state means the root/default profile.
  }
  return root;
}

export class DelegationRegistrationStore {
  private readonly registrationsByScope = new Map<string, Map<string, DelegationRegistration>>();

  private key(sessionId: string, generation: number): string {
    return `${sessionId}\0${generation}`;
  }

  register(sessionId: string, generation: number, registration: DelegationRegistration): void {
    const key = this.key(sessionId, generation);
    let registrations = this.registrationsByScope.get(key);
    if (!registrations) {
      for (const existing of this.registrationsByScope.keys()) {
        if (existing.startsWith(`${sessionId}\0`)) this.registrationsByScope.delete(existing);
      }
      registrations = new Map();
      this.registrationsByScope.set(key, registrations);
    }
    registrations.set(registration.delegationId, {
      ...registration,
      transcriptPaths: [...registration.transcriptPaths],
    });
    while (registrations.size > MAX_DELEGATIONS) {
      const oldest = registrations.keys().next().value as string | undefined;
      if (!oldest) break;
      registrations.delete(oldest);
    }
  }

  scope(
    sessionId: string | null | undefined,
    generation: number,
  ): DelegationActivityScope | undefined {
    if (!sessionId) return undefined;
    const registrations = this.registrationsByScope.get(this.key(sessionId, generation));
    return {
      sessionId,
      generation,
      registrations: registrations
        ? [...registrations.values()].map(item => ({ ...item, transcriptPaths: [...item.transcriptPaths] }))
        : [],
    };
  }
}

export class DelegationActivityMonitor {
  private timer: NodeJS.Timeout | undefined;
  private refreshTail: Promise<void> = Promise.resolve();
  private lastSignature = '';
  private lastScope: DelegationActivityScope | undefined;

  constructor(
    private readonly hermesHome: string | (() => string),
    private readonly scope: () => DelegationActivityScope | undefined,
    private readonly onUpdate: (scope: DelegationActivityScope, activities: AgentActivity[]) => void,
    private readonly intervalMs = 2_000,
  ) {}

  private sameScope(left: DelegationActivityScope, right: DelegationActivityScope): boolean {
    return left.sessionId === right.sessionId && left.generation === right.generation;
  }

  private publish(scope: DelegationActivityScope, activities: AgentActivity[]): void {
    const signature = JSON.stringify([scope.sessionId, scope.generation, activities]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.lastScope = { ...scope, registrations: scope.registrations.map(item => ({
      ...item,
      transcriptPaths: [...item.transcriptPaths],
    })) };
    this.onUpdate(scope, activities);
  }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs);
    this.timer.unref?.();
  }

  refresh(): Promise<void> {
    const requestedScope = this.scope();
    const run = async (): Promise<void> => {
      if (!requestedScope) {
        if (this.lastScope) this.publish(this.lastScope, []);
        return;
      }

      let activities: AgentActivity[] = [];
      try {
        const hermesHome = typeof this.hermesHome === 'function' ? this.hermesHome() : this.hermesHome;
        activities = await loadDelegationActivities(hermesHome, requestedScope.registrations);
      } catch {
        activities = [];
      }

      const currentScope = this.scope();
      if (!currentScope || !this.sameScope(requestedScope, currentScope)) {
        this.publish(currentScope ?? this.lastScope ?? requestedScope, []);
        return;
      }
      this.publish(currentScope, activities);
    };
    const queued = this.refreshTail.catch(() => {}).then(run);
    this.refreshTail = queued;
    return queued;
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
