import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as tar from 'tar';

/** What the last successful sync left on disk. Used to notice edits made by hand. */
export interface MirrorState {
  repo: string;
  branch: string;
  path: string;
  commit: string;
  syncedAt: string;
  hashes: Record<string, string>;
}

export function mirrorLayout(reposRoot: string, owner: string, repo: string): {
  root: string; mirror: string; state: string; tmp: string;
} {
  const root = path.join(reposRoot, `${owner}__${repo}`);
  return { root, mirror: path.join(root, 'mirror'), state: path.join(root, 'state.json'), tmp: path.join(root, 'tmp') };
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Relative posix path to SHA-256 for every file under a directory. */
export function hashTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(dir, full).split(path.sep).join('/')] = sha256(full);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

export function readState(stateFile: string): MirrorState | null {
  try {
    const doc = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as MirrorState;
    return doc && typeof doc.commit === 'string' && doc.hashes ? doc : null;
  } catch {
    return null;
  }
}

export function writeState(stateFile: string, state: MirrorState): void {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, stateFile);
}

/** Files that differ from what the last sync wrote: edited, added or removed by hand. */
export function detectLocalChanges(mirrorDir: string, state: MirrorState): string[] {
  const now = hashTree(mirrorDir);
  const changed = new Set<string>();
  for (const [file, hash] of Object.entries(now)) if (state.hashes[file] !== hash) changed.add(file);
  for (const file of Object.keys(state.hashes)) if (!(file in now)) changed.add(file);
  return [...changed].sort();
}

/**
 * Extracts only `<skillsPath>/` of a GitHub tarball into a staging folder.
 * GitHub wraps everything in one top level folder (`owner-repo-<sha>/`), which is stripped.
 */
export async function extractSkills(tarball: string, staging: string, skillsPath: string): Promise<number> {
  const wanted = skillsPath.replace(/^[\\/]+|[\\/]+$/g, '').split(/[\\/]+/).filter((s) => s && s !== '.');
  if (wanted.includes('..')) throw new Error('The skills path must stay inside the repository.');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  await tar.x({
    file: tarball,
    cwd: staging,
    strip: 1 + wanted.length,
    strict: true,
    preserveOwner: false,
    filter: (entryPath) => {
      const parts = entryPath.split('/').filter(Boolean);
      // parts[0] is the wrapper folder; the next parts must be the skills path.
      return parts.length > 1 + wanted.length && wanted.every((seg, i) => parts[1 + i] === seg);
    },
  });
  return Object.keys(hashTree(staging)).length;
}

/** Replaces the mirror with the staged tree. The previous mirror comes back if the swap fails. */
export function swapMirror(staging: string, mirror: string): void {
  const previous = `${mirror}.previous`;
  fs.rmSync(previous, { recursive: true, force: true });
  const hadMirror = fs.existsSync(mirror);
  if (hadMirror) fs.renameSync(mirror, previous);
  try {
    fs.renameSync(staging, mirror);
  } catch (err) {
    if (hadMirror) fs.renameSync(previous, mirror);
    throw err;
  }
  fs.rmSync(previous, { recursive: true, force: true });
}
