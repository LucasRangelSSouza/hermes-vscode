import * as fs from 'fs';
import * as path from 'path';
import { buildRuntimeEnv, runCapture } from '../runtime/process';
import type { CommandRunner } from '../providers/configWriter';
import { downloadTarball, fetchCommitSha, GithubError } from './github';
import type { GithubOptions, RepoRef } from './github';
import {
  detectLocalChanges, extractSkills, hashTree, mirrorLayout, readState, swapMirror, writeState,
} from './mirror';

export interface SyncRequest extends GithubOptions {
  /** `<data>/skills/repos` */
  reposRoot: string;
  repo: RepoRef;
  branch: string;
  skillsPath: string;
  /** Download again even when the commit is unchanged. */
  force?: boolean;
  /** Called when files in the mirror were edited by hand. Default is to keep them and cancel. */
  onLocalChanges?: (changed: string[]) => Promise<'overwrite' | 'cancel'>;
}

export type SyncOutcome =
  | { state: 'unchanged'; commit: string; files: number; mirror: string }
  | { state: 'updated'; commit: string; files: number; mirror: string }
  | { state: 'cancelled'; commit: string; files: number; mirror: string; changed: string[] };

export class SkillsSyncError extends Error {}

/**
 * Pull-only mirror of one folder of a GitHub repository, using the REST API. No Git is needed.
 * Nothing that was edited by hand is overwritten without asking.
 */
export async function syncSkills(req: SyncRequest): Promise<SyncOutcome> {
  const layout = mirrorLayout(req.reposRoot, req.repo.owner, req.repo.repo);
  const commit = await fetchCommitSha(req.repo, req.branch, req);
  const state = readState(layout.state);
  const mirrorExists = fs.existsSync(layout.mirror);
  const sameSource = state && state.repo === `${req.repo.owner}/${req.repo.repo}` && state.branch === req.branch && state.path === req.skillsPath;

  if (state && sameSource && mirrorExists) {
    const changed = detectLocalChanges(layout.mirror, state);
    if (state.commit === commit && !req.force && changed.length === 0) {
      return { state: 'unchanged', commit, files: Object.keys(state.hashes).length, mirror: layout.mirror };
    }
    if (changed.length > 0) {
      const choice = req.onLocalChanges ? await req.onLocalChanges(changed) : 'cancel';
      if (choice !== 'overwrite') {
        return { state: 'cancelled', commit, files: Object.keys(state.hashes).length, mirror: layout.mirror, changed };
      }
    }
  }

  fs.rmSync(layout.tmp, { recursive: true, force: true });
  fs.mkdirSync(layout.tmp, { recursive: true });
  const tarball = path.join(layout.tmp, 'repo.tar.gz');
  const staging = path.join(layout.tmp, 'staging');
  try {
    await downloadTarball(req.repo, req.branch, tarball, req);
    const files = await extractSkills(tarball, staging, req.skillsPath);
    if (files === 0) {
      throw new SkillsSyncError(`Nothing was found under "${req.skillsPath}" in ${req.repo.owner}/${req.repo.repo} (${req.branch}). Check the skills path.`);
    }
    fs.mkdirSync(layout.root, { recursive: true });
    swapMirror(staging, layout.mirror);
    writeState(layout.state, {
      repo: `${req.repo.owner}/${req.repo.repo}`, branch: req.branch, path: req.skillsPath,
      commit, syncedAt: new Date().toISOString(), hashes: hashTree(layout.mirror),
    });
    return { state: 'updated', commit, files, mirror: layout.mirror };
  } finally {
    fs.rmSync(layout.tmp, { recursive: true, force: true });
  }
}

export function describeError(err: unknown): string {
  if (err instanceof GithubError || err instanceof SkillsSyncError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Makes Hermes read the mirror as an external skills folder. Applied only when the folder changes. */
export async function applySkillsDir(req: {
  cliExe: string;
  hermesHome: string;
  statePath: string;
  mirrorDir: string;
  runner?: CommandRunner;
}): Promise<boolean> {
  const dir = req.mirrorDir.replace(/\\/g, '/');
  try {
    const saved = JSON.parse(fs.readFileSync(req.statePath, 'utf8')) as { dir?: string };
    if (saved.dir === dir && fs.existsSync(path.join(req.hermesHome, 'config.yaml'))) return false;
  } catch { /* not applied yet */ }
  fs.mkdirSync(req.hermesHome, { recursive: true });
  const env = buildRuntimeEnv(process.env, { hermesHome: req.hermesHome });
  const run = req.runner ?? runCapture;
  const result = await run(req.cliExe, ['config', 'set', 'skills.external_dirs', JSON.stringify([dir])], env, 60000);
  if (result.spawnError || result.timedOut || result.code !== 0) {
    throw new SkillsSyncError(`Could not point Hermes at the skills folder: ${(result.spawnError ?? result.stderr ?? '').toString().trim().slice(0, 300)}`);
  }
  fs.mkdirSync(path.dirname(req.statePath), { recursive: true });
  fs.writeFileSync(req.statePath, JSON.stringify({ dir, appliedAt: new Date().toISOString() }));
  return true;
}
