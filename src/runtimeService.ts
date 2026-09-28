import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { dataPaths, dataRoot, defaultExistingHermesHome } from './paths/hermesHome';
import type { DataPaths } from './paths/hermesHome';
import {
  DownloadError, InsufficientSpaceError, InstallLockedError, IntegrityError, installRuntime, readActive,
} from './runtime/installer';
import type { ActiveRuntime, InstallProgress } from './runtime/installer';
import {
  loadEmbeddedManifest, platformKey, runtimeForPlatform, selectPacks, totalBytes,
} from './runtime/manifest';
import type { PlatformRuntime } from './runtime/manifest';
import { RuntimeValidationError, readRuntimeJson, validateRuntime } from './runtime/validator';

export type RuntimeMode = 'automatic' | 'portable' | 'existing';

export interface ResolvedRuntime {
  mode: RuntimeMode;
  /** True when the extension owns HERMES_HOME (automatic and portable). */
  managed: boolean;
  entryExe: string;
  /** Fixed ACP launch arguments, or null to use the default `[--profile p] acp`. */
  entryArgs: string[] | null;
  cliExe: string;
  hermesHome: string;
  label: string;
}

const NS = 'hermesRangelTech';
const gb = (n: number): string => (n / 1024 ** 3).toFixed(1);

function readSetting<T>(key: string, fallback: T): T {
  const inspected = vscode.workspace.getConfiguration(NS).inspect<T>(key);
  // Workspace-scoped values are ignored on purpose: a repository must not choose what executable runs.
  return (inspected?.globalValue ?? inspected?.defaultValue ?? fallback) as T;
}

export class RuntimeService {
  readonly paths: DataPaths;
  private readonly validatedPortable = new Set<string>();
  private updateNoticeShown = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly log: (line: string) => void) {
    this.paths = dataPaths(dataRoot());
  }

  mode(): RuntimeMode {
    const m = readSetting<string>('runtime.mode', 'automatic');
    return m === 'portable' || m === 'existing' ? m : 'automatic';
  }

  private optionalPacks(): string[] {
    return readSetting<string[]>('runtime.optionalPacks', []);
  }

  private manifestRuntime(): PlatformRuntime {
    const manifest = loadEmbeddedManifest(this.context.extensionPath);
    const runtime = runtimeForPlatform(manifest);
    if (!runtime) {
      throw new Error(`No Hermes runtime is published for ${platformKey()}. Use a portable or an existing Hermes instead.`);
    }
    return runtime;
  }

  // ------------------------------------------------------------ resolve

  /** Finds the runtime to launch. With interactive set it may ask the user and install. */
  async resolve(interactive: boolean): Promise<ResolvedRuntime | null> {
    const mode = this.mode();
    if (mode === 'existing') return this.resolveExisting();
    if (mode === 'portable') return this.resolvePortable(interactive);
    return this.resolveAutomatic(interactive);
  }

  private async resolveAutomatic(interactive: boolean): Promise<ResolvedRuntime | null> {
    let runtime: PlatformRuntime;
    try {
      runtime = this.manifestRuntime();
    } catch (err) {
      this.log(`[runtime] ${err instanceof Error ? err.message : err}`);
      if (interactive) void vscode.window.showErrorMessage(`Hermes: ${err instanceof Error ? err.message : err}`);
      return null;
    }
    let active = readActive(this.paths);
    if (!active) {
      if (!interactive) return null;
      active = await this.offerInstall(runtime);
      if (!active) return null;
    } else if (active.id !== runtime.id && !this.updateNoticeShown) {
      this.updateNoticeShown = true;
      void vscode.window.showInformationMessage(
        `A newer Hermes runtime (${runtime.id}) ships with this version of the extension. You are on ${active.id}.`,
        'Update now',
      ).then((choice) => { if (choice === 'Update now') void vscode.commands.executeCommand(`${NS}.installRuntime`); });
    }
    try {
      const v = await validateRuntime(active.dir, { hermesHome: this.paths.home, structuralOnly: true });
      return {
        mode: 'automatic', managed: true, entryExe: v.entryExe, entryArgs: v.entryArgs, cliExe: v.cliExe,
        hermesHome: this.paths.home, label: `managed runtime ${active.id}`,
      };
    } catch (err) {
      await this.reportValidation(err);
      return null;
    }
  }

  private async resolvePortable(interactive: boolean): Promise<ResolvedRuntime | null> {
    let dir = readSetting<string>('runtime.portablePath', '').trim();
    if (!dir) {
      if (!interactive || !(await this.selectPortable())) return null;
      dir = readSetting<string>('runtime.portablePath', '').trim();
    }
    try {
      const full = !this.validatedPortable.has(dir);
      const v = await validateRuntime(dir, { hermesHome: this.paths.home, structuralOnly: !full });
      this.validatedPortable.add(dir);
      return {
        mode: 'portable', managed: true, entryExe: v.entryExe, entryArgs: v.entryArgs, cliExe: v.cliExe,
        hermesHome: this.paths.home, label: `portable runtime ${dir}`,
      };
    } catch (err) {
      await this.reportValidation(err);
      return null;
    }
  }

  private resolveExisting(): ResolvedRuntime | null {
    const configured = readSetting<string>('runtime.existingPath', 'hermes').trim() || 'hermes';
    let exe = configured;
    if (configured !== 'hermes' && !path.isAbsolute(configured)) {
      void vscode.window.showErrorMessage('Hermes: runtime.existingPath must be an absolute path or the default "hermes".');
      return null;
    }
    if (configured === 'hermes') {
      const found = this.findHermesOnMachine();
      if (!found) {
        void vscode.window.showErrorMessage(
          'Hermes: no existing Hermes binary was found. Switch the runtime mode back to automatic, or set the path.',
          'Open Settings',
        ).then((c) => { if (c) void vscode.commands.executeCommand('workbench.action.openSettings', `${NS}.runtime`); });
        return null;
      }
      exe = found;
    } else if (!fs.existsSync(exe)) {
      void vscode.window.showErrorMessage(`Hermes: the configured binary does not exist: ${exe}`);
      return null;
    }
    return {
      mode: 'existing', managed: false, entryExe: exe, entryArgs: null, cliExe: exe,
      hermesHome: defaultExistingHermesHome(), label: `existing Hermes ${exe}`,
    };
  }

  private findHermesOnMachine(): string | null {
    const win = process.platform === 'win32';
    try {
      const out = execFileSync(win ? 'where' : 'which', ['hermes'], { timeout: 3000, encoding: 'utf8', windowsHide: true });
      const first = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
      if (first) return first;
    } catch { /* not on PATH */ }
    const candidates = win
      ? [path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'hermes', 'bin', 'hermes.exe')]
      : [path.join(os.homedir(), '.local', 'bin', 'hermes'), '/usr/local/bin/hermes', '/usr/bin/hermes'];
    return candidates.find((c) => fs.existsSync(c)) ?? null;
  }

  // ------------------------------------------------------------ install

  private async offerInstall(runtime: PlatformRuntime): Promise<ActiveRuntime | null> {
    const packs = selectPacks(runtime, this.optionalPacks());
    const size = gb(totalBytes(packs));
    const install = 'Download and install';
    const portable = 'Use a portable runtime folder';
    const choice = await vscode.window.showInformationMessage(
      `Hermes needs its runtime before it can start (${size} GB download, about ${gb(totalBytes(packs) * 3)} GB on disk). `
      + 'It comes from this project\'s GitHub Releases, is checked against a SHA-256 hash and needs no administrator rights.',
      { modal: true },
      install,
      portable,
    );
    if (choice === install) return this.runInstall(runtime);
    if (choice === portable) {
      if (await this.selectPortable()) void vscode.commands.executeCommand(`${NS}.openChat`);
    }
    return null;
  }

  /** Command entry point: install or repair the managed runtime. */
  async install(): Promise<ActiveRuntime | null> {
    try {
      return await this.runInstall(this.manifestRuntime());
    } catch (err) {
      void vscode.window.showErrorMessage(`Hermes: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private async runInstall(runtime: PlatformRuntime): Promise<ActiveRuntime | null> {
    const packs = selectPacks(runtime, this.optionalPacks());
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Hermes: installing the runtime', cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        let lastPct = 0;
        let lastPhase = '';
        const onProgress = (p: InstallProgress): void => {
          const pct = p.totalBytes ? Math.min(100, Math.floor((p.doneBytes / p.totalBytes) * 100)) : 0;
          progress.report({
            increment: Math.max(0, pct - lastPct),
            message: p.phase === 'download'
              ? `${p.message}  ${gb(p.doneBytes)} of ${gb(p.totalBytes)} GB`
              : p.message,
          });
          lastPct = Math.max(lastPct, pct);
          const key = `${p.phase}:${p.pack ?? ''}`;
          if (key !== lastPhase) { lastPhase = key; this.log(`[runtime] ${p.message}`); }
        };
        try {
          const active = await installRuntime({ runtime, packs, paths: this.paths, onProgress, signal: abort.signal });
          this.log(`[runtime] installed ${active.id} at ${active.dir}`);
          void vscode.window.showInformationMessage(`Hermes runtime ${active.id} is ready.`);
          return active;
        } catch (err) {
          await this.reportInstallError(err);
          return null;
        }
      },
    );
  }

  private async reportInstallError(err: unknown): Promise<void> {
    const text = err instanceof Error ? err.message : String(err);
    this.log(`[runtime] install failed: ${text}`);
    if (text === 'Cancelled') return;
    if (err instanceof RuntimeValidationError) { await this.reportValidation(err); return; }
    if (err instanceof DownloadError) {
      const pick = await vscode.window.showErrorMessage(
        `The Hermes runtime could not be downloaded. Your network or organization may block this request. ${text}`,
        'Retry', 'Select Portable Runtime', 'View Logs',
      );
      if (pick === 'Retry') void vscode.commands.executeCommand(`${NS}.installRuntime`);
      else if (pick === 'Select Portable Runtime') void vscode.commands.executeCommand(`${NS}.selectPortableRuntime`);
      else if (pick === 'View Logs') void vscode.commands.executeCommand(`${NS}.showLogs`);
      return;
    }
    if (err instanceof IntegrityError || err instanceof InsufficientSpaceError || err instanceof InstallLockedError) {
      void vscode.window.showErrorMessage(`Hermes: ${text}`);
      return;
    }
    const pick = await vscode.window.showErrorMessage(`Hermes: installing the runtime failed. ${text}`, 'View Logs');
    if (pick === 'View Logs') void vscode.commands.executeCommand(`${NS}.showLogs`);
  }

  private async reportValidation(err: unknown): Promise<void> {
    if (!(err instanceof RuntimeValidationError)) {
      const text = err instanceof Error ? err.message : String(err);
      this.log(`[runtime] ${text}`);
      void vscode.window.showErrorMessage(`Hermes: ${text}`);
      return;
    }
    this.log(`[runtime] validation failed at ${err.step}: ${err.message}`);
    const details = err.exePath ? `\nExecutable: ${err.exePath}${err.exeSha256 ? `\nSHA-256: ${err.exeSha256}` : ''}` : '';
    if (err.exePath) this.log(`[runtime] executable ${err.exePath} sha256 ${err.exeSha256 ?? 'unknown'}`);
    const pick = await vscode.window.showErrorMessage(
      `Hermes runtime is not usable (${err.step}). ${err.message}${details}\nIf endpoint security blocks it, give IT the path and hash above.`,
      ...(err.exePath ? ['Copy Details'] : []),
      'Select Portable Runtime', 'View Logs',
    );
    if (pick === 'Copy Details') await vscode.env.clipboard.writeText(`${err.message}${details}`);
    else if (pick === 'Select Portable Runtime') void vscode.commands.executeCommand(`${NS}.selectPortableRuntime`);
    else if (pick === 'View Logs') void vscode.commands.executeCommand(`${NS}.showLogs`);
  }

  // ------------------------------------------------------------ portable

  async selectPortable(): Promise<boolean> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
      title: 'Select the Hermes portable runtime folder (it contains runtime.json)',
      openLabel: 'Use this runtime',
    });
    const dir = picked?.[0]?.fsPath;
    if (!dir) return false;
    try {
      readRuntimeJson(dir);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Hermes: validating the runtime' },
        () => validateRuntime(dir, { hermesHome: this.paths.home }),
      );
    } catch (err) {
      await this.reportValidation(err);
      return false;
    }
    this.validatedPortable.add(dir);
    const config = vscode.workspace.getConfiguration(NS);
    await config.update('runtime.portablePath', dir, vscode.ConfigurationTarget.Global);
    await config.update('runtime.mode', 'portable', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('Hermes will use the portable runtime you selected.');
    return true;
  }

  // ------------------------------------------------------------ status

  async status(): Promise<string> {
    const lines: string[] = [`Mode: ${this.mode()}`, `Data folder: ${this.paths.root}`];
    try {
      const runtime = this.manifestRuntime();
      lines.push(`Runtime shipped with this extension: ${runtime.id} (Hermes ${runtime.hermes.ref}, commit ${runtime.hermes.commit.slice(0, 9)})`);
    } catch (err) {
      lines.push(`Shipped runtime: ${err instanceof Error ? err.message : err}`);
    }
    const active = readActive(this.paths);
    lines.push(active ? `Installed: ${active.id} at ${active.dir} (packs: ${active.packs.join(', ')})` : 'Installed: none');
    return lines.join('\n');
  }
}
