import * as path from 'path';
import * as vscode from 'vscode';
import type { DataPaths } from './paths/hermesHome';
import { registerSecret } from './secrets/redactor';
import { fetchCommitSha, parseRepoRef } from './skills/github';
import type { RepoRef } from './skills/github';
import { mirrorLayout } from './skills/mirror';
import { applySkillsDir, describeError, syncSkills } from './skills/sync';
import type { SyncOutcome } from './skills/sync';
import type { ResolvedRuntime } from './runtimeService';

const NS = 'hermesRangelTech';
const TOKEN_KEY = 'hermesRangelTech/github/token';
const TRUSTED_KEY = 'hermesRangelTech.trustedSkillRepos';
const LAUNCH_SYNC_TIMEOUT_MS = 20000;

interface SkillsConfig {
  repo: RepoRef;
  branch: string;
  skillsPath: string;
}

function readSetting<T>(key: string, fallback: T): T {
  const inspected = vscode.workspace.getConfiguration(NS).inspect<T>(key);
  // Machine scoped: a workspace cannot point Hermes at a repository of its own choosing.
  return (inspected?.globalValue ?? inspected?.defaultValue ?? fallback) as T;
}

export class SkillsService {
  private readonly reposRoot: string;
  private noticeShown = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
    private readonly paths: DataPaths,
  ) {
    this.reposRoot = path.join(paths.skills, 'repos');
  }

  config(): SkillsConfig | null {
    const repo = parseRepoRef(readSetting<string>('skills.repository', ''));
    if (!repo) return null;
    return {
      repo,
      branch: readSetting<string>('skills.branch', 'main').trim() || 'main',
      skillsPath: readSetting<string>('skills.path', 'skills').trim() || 'skills',
    };
  }

  syncOnStartup(): boolean { return readSetting<boolean>('skills.syncOnStartup', true); }
  syncBeforeLaunch(): boolean { return readSetting<boolean>('skills.syncBeforeLaunch', true); }

  private async token(): Promise<string | undefined> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    registerSecret(token);
    return token;
  }

  private isTrusted(repo: RepoRef): boolean {
    return this.context.globalState.get<string[]>(TRUSTED_KEY, []).includes(`${repo.owner}/${repo.repo}`);
  }

  private async confirmTrust(repo: RepoRef): Promise<boolean> {
    if (this.isTrusted(repo)) return true;
    const yes = 'Trust and sync';
    const choice = await vscode.window.showWarningMessage(
      `Skills from ${repo.owner}/${repo.repo} will be read by Hermes, and a skill can include scripts that Hermes may run on your machine. Only sync repositories you trust.`,
      { modal: true },
      yes,
    );
    if (choice !== yes) return false;
    const list = this.context.globalState.get<string[]>(TRUSTED_KEY, []);
    await this.context.globalState.update(TRUSTED_KEY, [...list, `${repo.owner}/${repo.repo}`]);
    return true;
  }

  /** Guided setup: repository, branch, folder and an optional token, then a test and a first sync. */
  async configure(): Promise<boolean> {
    const current = this.config();
    const repoText = await vscode.window.showInputBox({
      title: 'Skills sync (1/4): GitHub repository', prompt: 'owner/repo or the repository URL',
      value: current ? `${current.repo.owner}/${current.repo.repo}` : '', ignoreFocusOut: true,
      validateInput: (v) => (parseRepoRef(v) ? undefined : 'Enter owner/repo or a github.com URL.'),
    });
    if (repoText === undefined) return false;
    const repo = parseRepoRef(repoText);
    if (!repo) return false;
    const branch = await vscode.window.showInputBox({
      title: 'Skills sync (2/4): branch', value: current?.branch ?? 'main', ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Enter a branch name.'),
    });
    if (branch === undefined) return false;
    const skillsPath = await vscode.window.showInputBox({
      title: 'Skills sync (3/4): folder with the skills', prompt: 'Path inside the repository, for example skills',
      value: current?.skillsPath ?? 'skills', ignoreFocusOut: true,
      validateInput: (v) => (v.trim() && !v.split(/[\\/]/).includes('..') ? undefined : 'Enter a folder inside the repository.'),
    });
    if (skillsPath === undefined) return false;
    const token = await vscode.window.showInputBox({
      title: 'Skills sync (4/4): GitHub token (private repositories only)',
      prompt: 'Leave empty for a public repository or to keep the stored token. Use a fine-grained token for this repository with Contents: read-only.',
      password: true, ignoreFocusOut: true,
    });
    if (token === undefined) return false;
    if (token) {
      await this.context.secrets.store(TOKEN_KEY, token);
      registerSecret(token);
    }

    const saved = token || (await this.context.secrets.get(TOKEN_KEY));
    try {
      const sha = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Hermes: checking the skills repository' },
        () => fetchCommitSha(repo, branch.trim(), { token: saved || undefined }),
      );
      this.log(`[skills] reached ${repo.owner}/${repo.repo} at ${sha.slice(0, 9)}`);
    } catch (err) {
      const pick = await vscode.window.showErrorMessage(`Skills repository check failed: ${describeError(err)}`, 'Save anyway', 'Cancel');
      if (pick !== 'Save anyway') return false;
    }

    const config = vscode.workspace.getConfiguration(NS);
    await config.update('skills.repository', `${repo.owner}/${repo.repo}`, vscode.ConfigurationTarget.Global);
    await config.update('skills.branch', branch.trim(), vscode.ConfigurationTarget.Global);
    await config.update('skills.path', skillsPath.trim(), vscode.ConfigurationTarget.Global);
    await this.syncNow('manual');
    return true;
  }

  /** One sync. Manual runs show progress and ask about conflicts; background runs stay quiet. */
  async syncNow(reason: 'manual' | 'startup' | 'launch'): Promise<SyncOutcome | undefined> {
    const cfg = this.config();
    if (!cfg) {
      if (reason === 'manual') {
        const go = await vscode.window.showInformationMessage('No skills repository is configured yet.', 'Configure now');
        if (go) await this.configure();
      }
      return undefined;
    }
    if (reason === 'manual' ? !(await this.confirmTrust(cfg.repo)) : !this.isTrusted(cfg.repo)) {
      if (reason !== 'manual') this.log('[skills] repository not trusted yet; run "Hermes: Sync Skills" once to approve it');
      return undefined;
    }
    const token = await this.token();
    const run = (): Promise<SyncOutcome> => syncSkills({
      reposRoot: this.reposRoot, repo: cfg.repo, branch: cfg.branch, skillsPath: cfg.skillsPath,
      token: token || undefined,
      force: reason === 'manual',
      onLocalChanges: async (changed) => {
        if (reason !== 'manual') return 'cancel';
        const overwrite = 'Overwrite with remote';
        const shown = changed.slice(0, 8).join('\n');
        const more = changed.length > 8 ? `\n…and ${changed.length - 8} more` : '';
        const choice = await vscode.window.showWarningMessage(
          `Files in the synced skills folder were changed on this machine:\n${shown}${more}\n\nOverwrite them with the version from GitHub?`,
          { modal: true }, overwrite,
        );
        return choice === overwrite ? 'overwrite' : 'cancel';
      },
    });
    try {
      const outcome = reason === 'manual'
        ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Hermes: syncing skills' }, run)
        : await run();
      this.log(`[skills] ${reason} sync: ${outcome.state} (${outcome.files} files, ${outcome.commit.slice(0, 9)})`);
      if (reason === 'manual') {
        const text = outcome.state === 'updated' ? `Skills updated: ${outcome.files} files.`
          : outcome.state === 'unchanged' ? 'Skills are already up to date.'
            : 'Sync cancelled. Your local changes were kept.';
        void vscode.window.showInformationMessage(text);
      }
      return outcome;
    } catch (err) {
      const text = describeError(err);
      this.log(`[skills] ${reason} sync failed: ${text}`);
      if (reason === 'manual') {
        const pick = await vscode.window.showErrorMessage(`Skills repository could not be synchronized. ${text}`, 'Check Token', 'Retry');
        if (pick === 'Check Token') await this.configure();
        else if (pick === 'Retry') return this.syncNow('manual');
      } else if (!this.noticeShown) {
        this.noticeShown = true;
        void vscode.window.showWarningMessage(`Hermes skills could not be synced (${text}). Using the last copy.`);
      }
      return undefined;
    }
  }

  /**
   * Before the agent starts: refresh the mirror within a time limit (a failure never blocks startup)
   * and make sure Hermes reads it.
   */
  async prepareForLaunch(resolved: ResolvedRuntime): Promise<void> {
    if (!resolved.managed) return;
    const cfg = this.config();
    if (!cfg) return;
    if (this.syncBeforeLaunch()) {
      await Promise.race([
        this.syncNow('launch'),
        new Promise<undefined>((r) => setTimeout(() => { this.log('[skills] sync before launch timed out; continuing'); r(undefined); }, LAUNCH_SYNC_TIMEOUT_MS)),
      ]);
    }
    const layout = mirrorLayout(this.reposRoot, cfg.repo.owner, cfg.repo.repo);
    try {
      const changed = await applySkillsDir({
        cliExe: resolved.cliExe, hermesHome: resolved.hermesHome,
        statePath: path.join(this.paths.state, 'skills-dir.json'), mirrorDir: layout.mirror,
      });
      if (changed) this.log(`[skills] Hermes now reads ${layout.mirror}`);
    } catch (err) {
      this.log(`[skills] ${describeError(err)}`);
    }
  }
}
