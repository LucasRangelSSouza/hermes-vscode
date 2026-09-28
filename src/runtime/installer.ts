import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import type { DataPaths } from '../paths/hermesHome';
import type { PackEntry, PlatformRuntime } from './manifest';
import { totalBytes } from './manifest';
import { sha256File, validateRuntime } from './validator';

export type InstallPhase = 'prepare' | 'download' | 'verify' | 'extract' | 'validate' | 'activate';

export interface InstallProgress {
  phase: InstallPhase;
  pack?: string;
  /** Bytes downloaded so far across all packs (download phase). */
  doneBytes: number;
  totalBytes: number;
  message: string;
}

export interface UrlPolicy {
  isAllowed(url: URL): boolean;
}

/** Default: HTTPS only, GitHub release hosts only. */
export const STRICT_POLICY: UrlPolicy = {
  isAllowed: (u) => u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com')),
};

export interface ActiveRuntime {
  id: string;
  dir: string;
  packs: string[];
  hermes: { ref: string; commit: string };
  installedAt: string;
}

export class IntegrityError extends Error {}
export class InsufficientSpaceError extends Error {}
export class DownloadError extends Error {}
export class InstallLockedError extends Error {}

export interface InstallRequest {
  runtime: PlatformRuntime;
  packs: PackEntry[];
  paths: DataPaths;
  platform?: NodeJS.Platform;
  arch?: string;
  policy?: UrlPolicy;
  fetchImpl?: typeof fetch;
  onProgress?: (p: InstallProgress) => void;
  signal?: AbortSignal;
  /** Only tests turn this off. */
  validate?: boolean;
  /** Multiplier of compressed size that must be free before starting. */
  spaceFactor?: number;
  retryDelayMs?: number;
}

export function activeFile(paths: DataPaths): string {
  return path.join(paths.state, 'active.json');
}

export function readActive(paths: DataPaths): ActiveRuntime | null {
  try {
    const doc = JSON.parse(fs.readFileSync(activeFile(paths), 'utf8')) as ActiveRuntime;
    if (!doc || typeof doc.dir !== 'string' || typeof doc.id !== 'string') return null;
    if (!fs.existsSync(path.join(doc.dir, 'runtime.json'))) return null;
    return doc;
  } catch {
    return null;
  }
}

function writeActive(paths: DataPaths, active: ActiveRuntime): void {
  fs.mkdirSync(paths.state, { recursive: true });
  const tmp = `${activeFile(paths)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(active, null, 2));
  fs.renameSync(tmp, activeFile(paths));
}

// ---------------------------------------------------------------- lock

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Two VS Code windows on first run must not both download. */
export function acquireInstallLock(paths: DataPaths, staleMs = 30 * 60 * 1000): () => void {
  fs.mkdirSync(paths.state, { recursive: true });
  const dir = path.join(paths.state, 'runtime.lock');
  const owner = path.join(dir, 'owner.json');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const info = JSON.parse(fs.readFileSync(owner, 'utf8')) as { pid: number; at: number };
        stale = !pidAlive(info.pid) || Date.now() - info.at > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) throw new InstallLockedError('Another VS Code window is installing the Hermes runtime. Wait for it to finish.');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new InstallLockedError('Could not take the runtime install lock.');
}

// ---------------------------------------------------------------- download

async function fetchFollow(
  url: string,
  headers: Record<string, string>,
  policy: UrlPolicy,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const parsed = new URL(current);
    if (!policy.isAllowed(parsed)) throw new DownloadError(`Refusing to download from ${parsed.origin}: not a trusted release host.`);
    const res = await fetchImpl(current, { headers, redirect: 'manual', signal });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new DownloadError('Redirect without a location.');
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new DownloadError('Too many redirects.');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Cancelled')); }, { once: true });
  });
}

async function downloadPack(
  pack: PackEntry,
  cacheDir: string,
  req: InstallRequest,
  onBytes: (n: number) => void,
  resetBytes: (n: number) => void,
): Promise<string> {
  const policy = req.policy ?? STRICT_POLICY;
  const fetchImpl = req.fetchImpl ?? fetch;
  const finalPath = path.join(cacheDir, pack.file);
  const partial = `${finalPath}.partial`;

  if (fs.existsSync(finalPath) && fs.statSync(finalPath).size === pack.bytes && await sha256File(finalPath) === pack.sha256) {
    onBytes(pack.bytes);
    return finalPath;
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (req.signal?.aborted) throw new Error('Cancelled');
    let existing = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    if (existing > pack.bytes) { fs.rmSync(partial, { force: true }); existing = 0; }
    try {
      const res = await fetchFollow(pack.url, existing > 0 ? { Range: `bytes=${existing}-` } : {}, policy, fetchImpl, req.signal);
      if (res.status === 200 && existing > 0) { fs.rmSync(partial, { force: true }); existing = 0; resetBytes(0); }
      if (res.status !== 200 && res.status !== 206) throw new DownloadError(`Download of ${pack.file} failed: HTTP ${res.status}.`);
      if (!res.body) throw new DownloadError(`Download of ${pack.file} returned no data.`);
      resetBytes(existing);
      const source = Readable.fromWeb(res.body as never);
      source.on('data', (chunk: Buffer) => onBytes(chunk.length));
      await pipeline(source, fs.createWriteStream(partial, { flags: res.status === 206 ? 'a' : 'w' }));
      lastError = undefined;
      break;
    } catch (err) {
      if (err instanceof DownloadError && /HTTP 4\d\d|trusted/.test(err.message)) throw err;
      if (req.signal?.aborted) throw new Error('Cancelled');
      lastError = err;
      await sleep((req.retryDelayMs ?? 1500) * (attempt + 1), req.signal);
    }
  }
  if (lastError) throw new DownloadError(`Download of ${pack.file} failed after several attempts: ${lastError instanceof Error ? lastError.message : lastError}`);
  const size = fs.statSync(partial).size;
  if (size !== pack.bytes) {
    fs.rmSync(partial, { force: true });
    throw new IntegrityError(`${pack.file} has ${size} bytes, expected ${pack.bytes}.`);
  }
  const got = await sha256File(partial);
  if (got !== pack.sha256) {
    fs.rmSync(partial, { force: true });
    throw new IntegrityError(`${pack.file} failed its SHA-256 check (got ${got}). It was deleted; nothing was installed.`);
  }
  fs.renameSync(partial, finalPath);
  return finalPath;
}

// ---------------------------------------------------------------- install

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    try { fs.renameSync(from, to); return; } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i === 7 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
}

async function ensureFreeSpace(dir: string, needed: number): Promise<void> {
  const statfs = (fs.promises as unknown as { statfs?: (p: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> }).statfs;
  if (!statfs) return;
  try {
    const s = await statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < needed) {
      const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);
      throw new InsufficientSpaceError(`Not enough free disk space: the runtime needs about ${gb(needed)} GB and only ${gb(free)} GB is free in ${dir}.`);
    }
  } catch (err) {
    if (err instanceof InsufficientSpaceError) throw err;
  }
}

/**
 * Extracts one pack. Symbolic links are skipped everywhere, not only on Windows (where creating
 * them needs Developer Mode or elevation): a Linux runtime build was found to include a symlink
 * whose path is later written through by another entry, which node-tar refuses as a path-traversal
 * guard (`TAR_SYMLINK_ERROR`) and which aborts the whole extraction. The runtime does not depend on
 * these links; the loader/launcher scripts record real, resolved paths (confirmed in docs/spikes.md,
 * S1 and S1b — the same skip already passed a full ACP round trip and a terminal tool call on
 * Windows). Informational warnings are ignored; anything else is an error.
 */
export async function extractPack(archive: string, dest: string): Promise<string[]> {
  fs.mkdirSync(dest, { recursive: true });
  const skipped: string[] = [];
  const problems: string[] = [];
  await tar.x({
    file: archive,
    cwd: dest,
    preserveOwner: false,
    filter: (entryPath, entry) => {
      if ((entry as { type?: string }).type === 'SymbolicLink') {
        skipped.push(entryPath);
        return false;
      }
      return true;
    },
    onwarn: (code: string, message: string) => {
      if (code !== 'TAR_ENTRY_INFO') problems.push(`${code}: ${message}`);
    },
  });
  if (problems.length > 0) {
    throw new Error(`Extracting ${path.basename(archive)} failed: ${problems.slice(0, 3).join('; ')}`);
  }
  return skipped;
}

function collectGarbage(paths: DataPaths, keep: Set<string>): void {
  let entries: string[] = [];
  try { entries = fs.readdirSync(paths.runtime); } catch { return; }
  for (const name of entries) {
    if (keep.has(name)) continue;
    try { fs.rmSync(path.join(paths.runtime, name), { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export async function installRuntime(req: InstallRequest): Promise<ActiveRuntime> {
  const { runtime, packs, paths } = req;
  const platform = req.platform ?? process.platform;
  const arch = req.arch ?? process.arch;
  const total = totalBytes(packs);
  const report = (p: Partial<InstallProgress> & { phase: InstallPhase; message: string }, done = 0): void =>
    req.onProgress?.({ doneBytes: done, totalBytes: total, ...p });

  fs.mkdirSync(paths.runtime, { recursive: true });
  fs.mkdirSync(paths.cache, { recursive: true });
  const release = acquireInstallLock(paths);
  try {
    const current = readActive(paths);
    const sameRuntime = current && current.id === runtime.id;
    const wanted = packs.map((p) => p.name);
    const missing = sameRuntime ? packs.filter((p) => !current.packs.includes(p.name)) : packs;
    if (sameRuntime && missing.length === 0) {
      report({ phase: 'activate', message: 'Runtime already installed.' }, total);
      return current;
    }

    report({ phase: 'prepare', message: 'Checking free disk space' });
    await ensureFreeSpace(paths.runtime, totalBytes(missing) * (req.spaceFactor ?? 3.5));

    let done = 0;
    const archives: Array<{ pack: PackEntry; file: string }> = [];
    for (const pack of missing) {
      report({ phase: 'download', pack: pack.name, message: `Downloading ${pack.name}` }, done);
      const before = done;
      const file = await downloadPack(
        pack, paths.cache, req,
        (n) => { done += n; report({ phase: 'download', pack: pack.name, message: `Downloading ${pack.name}` }, Math.min(done, total)); },
        (n) => { done = before + n; },
      );
      done = before + pack.bytes;
      report({ phase: 'verify', pack: pack.name, message: `Verified ${pack.name}` }, done);
      archives.push({ pack, file });
    }

    const targetDir = sameRuntime ? current.dir : path.join(paths.runtime, runtime.id);
    const stagingDir = sameRuntime ? targetDir : path.join(paths.runtime, `${runtime.id}.staging`);
    if (!sameRuntime) fs.rmSync(stagingDir, { recursive: true, force: true });
    for (const { pack, file } of archives) {
      report({ phase: 'extract', pack: pack.name, message: `Extracting ${pack.name}` }, total);
      await extractPack(file, stagingDir);
    }

    if (req.validate !== false) {
      report({ phase: 'validate', message: 'Validating the runtime' }, total);
      await validateRuntime(stagingDir, { platform, arch, hermesHome: paths.home });
    }

    let finalDir = targetDir;
    if (!sameRuntime) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      await renameWithRetry(stagingDir, targetDir);
      finalDir = targetDir;
    }
    const installedPacks = sameRuntime ? [...new Set([...current.packs, ...wanted])] : wanted;
    const active: ActiveRuntime = {
      id: runtime.id, dir: finalDir, packs: installedPacks, hermes: runtime.hermes, installedAt: new Date().toISOString(),
    };
    report({ phase: 'activate', message: 'Activating the runtime' }, total);
    writeActive(paths, active);
    for (const { file } of archives) { try { fs.rmSync(file, { force: true }); } catch { /* keep going */ } }
    collectGarbage(paths, new Set([runtime.id, ...(current && !sameRuntime ? [path.basename(current.dir)] : [])]));
    return active;
  } finally {
    release();
  }
}
