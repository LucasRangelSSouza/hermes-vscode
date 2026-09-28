import { open, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentActivity } from './agentActivity';
import { activeHermesHome } from './paths/hermesHome';

export interface RoleRunScope {
  workspaceRoot: string;
  scopeId?: string;
}

interface ParsedRoleRun {
  activity: AgentActivity;
  startedAt: number;
}

export interface RoleRunLoadOptions {
  now?: () => number;
  processIsAlive?: (pid: number) => boolean;
  heartbeatStaleAfterMs?: number;
}

const STATUS_MAP: Readonly<Record<string, AgentActivity['status']>> = {
  starting: 'starting',
  running: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  timed_out: 'failed',
};
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GIT_POINTER_BYTES = 4 * 1024;
const DEFAULT_HEARTBEAT_STALE_AFTER_MS = 60_000;
const MAX_HEARTBEAT_FUTURE_SKEW_MS = 5_000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('Git metadata exceeds size limit');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function gitMetadataPath(raw: string): string | undefined {
  let value = raw;
  if (value.endsWith('\r\n')) {
    value = value.slice(0, -2);
  } else if (value.endsWith('\n')) {
    value = value.slice(0, -1);
  } else if (value.endsWith('\r')) {
    return undefined;
  }
  if (!value || value.includes('\n') || value.includes('\r')) return undefined;
  return value;
}

function gitFileTarget(raw: string): string | undefined {
  const line = gitMetadataPath(raw);
  if (!line?.startsWith('gitdir: ')) return undefined;
  const target = line.slice('gitdir: '.length);
  return target || undefined;
}

async function gitCommonDirectory(repoRoot: string): Promise<string | undefined> {
  const dotGit = path.join(repoRoot, '.git');
  let gitDirectory: string;
  let linkedWorktree = false;
  try {
    const metadata = await stat(dotGit);
    if (metadata.isDirectory()) {
      return canonicalPath(dotGit);
    } else if (metadata.isFile()) {
      linkedWorktree = true;
      const target = gitFileTarget(await readBoundedText(dotGit, MAX_GIT_POINTER_BYTES));
      if (!target) return undefined;
      gitDirectory = path.resolve(repoRoot, target);
      if (!(await stat(gitDirectory)).isDirectory()) return undefined;
    } else {
      return undefined;
    }
  } catch {
    return undefined;
  }

  let commonDirectory = gitDirectory;
  try {
    const pointer = gitMetadataPath(await readBoundedText(path.join(gitDirectory, 'commondir'), MAX_GIT_POINTER_BYTES));
    if (!pointer) return undefined;
    commonDirectory = path.resolve(gitDirectory, pointer);
  } catch (error) {
    if (linkedWorktree || (error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
  }

  const commonDirectoryPath = await canonicalPath(commonDirectory);
  if (linkedWorktree) {
    try {
      const gitDirectoryPath = await canonicalPath(gitDirectory);
      const worktreesDirectoryPath = await canonicalPath(path.join(commonDirectoryPath, 'worktrees'));
      if (path.dirname(gitDirectoryPath) !== worktreesDirectoryPath) return undefined;

      const backlink = gitMetadataPath(await readBoundedText(path.join(gitDirectory, 'gitdir'), MAX_GIT_POINTER_BYTES));
      if (!backlink) return undefined;
      const backlinkPath = path.resolve(gitDirectory, backlink);
      const [canonicalBacklink, canonicalDotGit] = await Promise.all([
        canonicalPath(backlinkPath),
        canonicalPath(dotGit),
      ]);
      if (canonicalBacklink !== canonicalDotGit) return undefined;
    } catch {
      return undefined;
    }
  }
  return commonDirectoryPath;
}

function createWorkspaceMatcher(): (left: string, right: string) => Promise<boolean> {
  const canonicalPaths = new Map<string, Promise<string>>();
  const commonDirectories = new Map<string, Promise<string | undefined>>();
  const canonical = (candidate: string): Promise<string> => {
    const key = path.resolve(candidate);
    let value = canonicalPaths.get(key);
    if (!value) {
      value = canonicalPath(key);
      canonicalPaths.set(key, value);
    }
    return value;
  };
  const common = (candidate: string): Promise<string | undefined> => {
    const key = path.resolve(candidate);
    let value = commonDirectories.get(key);
    if (!value) {
      value = gitCommonDirectory(key);
      commonDirectories.set(key, value);
    }
    return value;
  };

  return async (left: string, right: string): Promise<boolean> => {
    const [leftPath, rightPath] = await Promise.all([canonical(left), canonical(right)]);
    if (leftPath === rightPath) return true;
    const [leftCommon, rightCommon] = await Promise.all([common(leftPath), common(rightPath)]);
    return leftCommon !== undefined && leftCommon === rightCommon;
  };
}

async function parseManifest(
  raw: unknown,
  manifestDirectory: string,
  scope: RoleRunScope,
  options: Required<RoleRunLoadOptions>,
  workspaceMatches: (left: string, right: string) => Promise<boolean>,
): Promise<ParsedRoleRun | undefined> {
  const data = record(raw);
  if (!data || data.schema_version !== '1.0.0' || data.execution_mode !== 'standalone_fresh_session') return undefined;

  const repoRoot = typeof data.repo_root === 'string' ? data.repo_root : '';
  if (!repoRoot || !await workspaceMatches(repoRoot, scope.workspaceRoot)) return undefined;

  const startedAt = typeof data.started_at === 'string' ? Date.parse(data.started_at) : Number.NaN;
  if (!Number.isFinite(startedAt)) return undefined;

  const role = typeof data.role === 'string' ? data.role.trim() : '';
  const roleId = typeof data.role_id === 'string' ? data.role_id.trim() : '';
  const runId = typeof data.run_id === 'string' ? data.run_id : '';
  const status = typeof data.status === 'string' ? STATUS_MAP[data.status] : undefined;
  if (!role || role.length > 100 || !ROLE_ID.test(roleId) || !runId || !status) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(runId) || runId !== path.basename(manifestDirectory)) return undefined;

  // This bar is a live control surface, not role history. Active-looking
  // manifests must still have both a live child and a fresh runner heartbeat.
  if (data.status !== 'starting' && data.status !== 'running') return undefined;
  const pid = safeTokenCount(data.pid);
  const heartbeatAt = typeof data.heartbeat_at === 'string' ? Date.parse(data.heartbeat_at) : Number.NaN;
  if (!pid || !options.processIsAlive(pid)) return undefined;
  const heartbeatAge = options.now() - heartbeatAt;
  if (!Number.isFinite(heartbeatAt)
    || heartbeatAge < -MAX_HEARTBEAT_FUTURE_SKEW_MS
    || heartbeatAge > options.heartbeatStaleAfterMs) return undefined;

  const context = record(data.context);
  const contextUsed = safeTokenCount(data.context_used ?? context?.used);
  const contextSize = safeTokenCount(data.context_size ?? context?.size);
  const compressionCount = safeTokenCount(data.compression_count ?? context?.compression_count);
  const activity: AgentActivity = {
    id: `role-run:${runId}`,
    name: role,
    status,
    ...(contextUsed !== undefined ? { contextUsed } : {}),
    ...(contextSize !== undefined ? { contextSize } : {}),
    ...(compressionCount !== undefined ? { compressionCount } : {}),
  };
  return {
    activity,
    startedAt,
  };
}

async function readBoundedJson(manifestPath: string): Promise<unknown> {
  const handle = await open(manifestPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(MAX_MANIFEST_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error('role manifest exceeds size limit');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Load canonical live standalone-role manifests for one VS Code workspace.
 *
 * The manifest is authoritative for identity and lifecycle. Missing fields are
 * omitted rather than inferred from packet text or process names. A role can
 * predate a restored Lead session; live PID + fresh heartbeat are the runtime
 * gates, while exact-path or shared Git-worktree identity prevents cross-repository leakage.
 */
export async function loadRoleRunActivities(
  runtimeRoot: string,
  scope: RoleRunScope,
  suppliedOptions: RoleRunLoadOptions = {},
): Promise<AgentActivity[]> {
  const options: Required<RoleRunLoadOptions> = {
    now: suppliedOptions.now ?? Date.now,
    processIsAlive: suppliedOptions.processIsAlive ?? processIsAlive,
    heartbeatStaleAfterMs: suppliedOptions.heartbeatStaleAfterMs ?? DEFAULT_HEARTBEAT_STALE_AFTER_MS,
  };
  const workspaceMatches = createWorkspaceMatcher();
  let directories;
  try {
    directories = await readdir(path.join(runtimeRoot, 'runs'), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const manifests = directories
    .filter(entry => entry.isDirectory())
    .sort((left, right) => right.name.localeCompare(left.name))
    .slice(0, 200);
  const parsed: Array<ParsedRoleRun | undefined> = [];
  for (let index = 0; index < manifests.length; index += 8) {
    const batch = manifests.slice(index, index + 8);
    parsed.push(...await Promise.all(batch.map(async entry => {
      const manifestDirectory = path.join(runtimeRoot, 'runs', entry.name);
      try {
        const raw = await readBoundedJson(path.join(manifestDirectory, 'manifest.json'));
        return parseManifest(raw, manifestDirectory, scope, options, workspaceMatches);
      } catch {
        return undefined;
      }
    })));
  }

  return parsed
    .filter((item): item is ParsedRoleRun => item !== undefined)
    .sort((left, right) => right.startedAt - left.startedAt)
    .slice(0, 12)
    .map(item => item.activity);
}

export function defaultRoleRunsRoot(): string {
  return path.join(activeHermesHome(), 'role-runs');
}

export class RoleRunMonitor {
  private timer: NodeJS.Timeout | undefined;
  private refreshTail: Promise<void> = Promise.resolve();
  private lastSignature = '';
  private lastScope: RoleRunScope | undefined;

  constructor(
    private readonly runtimeRoot: string,
    private readonly scope: () => RoleRunScope | undefined,
    private readonly onUpdate: (scope: RoleRunScope, activities: AgentActivity[]) => void,
    private readonly intervalMs = 2_000,
  ) {}

  private sameScope(left: RoleRunScope, right: RoleRunScope): boolean {
    return left.scopeId === right.scopeId
      && path.resolve(left.workspaceRoot) === path.resolve(right.workspaceRoot);
  }

  private publish(scope: RoleRunScope, activities: AgentActivity[]): void {
    const signature = JSON.stringify([scope.scopeId, scope.workspaceRoot, activities]);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.lastScope = { ...scope };
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

      let activities: AgentActivity[];
      try {
        activities = await loadRoleRunActivities(this.runtimeRoot, requestedScope);
      } catch {
        // Runtime manifests are optional metadata. I/O failures clear stale
        // role state instead of destabilising the extension host.
        activities = [];
      }

      const currentScope = this.scope();
      if (!currentScope || !this.sameScope(requestedScope, currentScope)) {
        // A workspace switch can race an asynchronous manifest scan. Never
        // publish role identity from the superseded scope into the active UI.
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
