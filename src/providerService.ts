import * as path from 'path';
import * as vscode from 'vscode';
import { applyProfile } from './providers/configWriter';
import { summarize, testConnection } from './providers/connectionTest';
import {
  DEFAULT_TIMEOUT_SECONDS, ProfileStore, apiKeyEnvName, isLoopbackHost, newProfileId, normalizeBaseUrl, validateProfile,
} from './providers/profile';
import type { ProviderProfile } from './providers/profile';
import { registerSecret } from './secrets/redactor';
import type { ResolvedRuntime } from './runtimeService';

const NS = 'hermesRangelTech';

export class ProviderService {
  readonly store: ProfileStore;

  constructor(
    context: vscode.ExtensionContext,
    private readonly log: (line: string) => void,
    private readonly stateDir: string,
  ) {
    this.store = new ProfileStore(context.globalState, context.secrets);
  }

  /** The active profile, asking the user to create one when none exists and interactive is set. */
  async ensureActive(interactive: boolean): Promise<ProviderProfile | undefined> {
    const active = this.store.active();
    if (active || !interactive) return active;
    return this.configure();
  }

  /**
   * Writes the active profile into the private Hermes home and returns the environment variable that
   * carries its API key. The key is read from SecretStorage here and lives only in the child's environment.
   */
  async prepare(resolved: ResolvedRuntime, profile: ProviderProfile): Promise<Record<string, string>> {
    const key = await this.store.apiKey(profile.id);
    registerSecret(key);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Hermes: applying provider settings' },
      async () => {
        const changed = await applyProfile({
          cliExe: resolved.cliExe,
          hermesHome: resolved.hermesHome,
          statePath: path.join(this.stateDir, 'applied-profile.json'),
          profile,
        });
        if (changed) this.log(`[provider] applied profile "${profile.name}" (${normalizeBaseUrl(profile.baseUrl)}, model ${profile.model})`);
      },
    );
    return key !== undefined ? { [apiKeyEnvName(profile.id)]: key } : {};
  }

  /** Guided setup: pick or create a profile, collect fields, test the connection, save. */
  async configure(): Promise<ProviderProfile | undefined> {
    let base: ProviderProfile | undefined;
    const existing = this.store.list();
    if (existing.length > 0) {
      const NEW = '$(add) New profile';
      const picked = await vscode.window.showQuickPick(
        [...existing.map((p) => ({ label: p.name, description: `${p.model} at ${p.baseUrl}`, profile: p })),
          { label: NEW, description: '', profile: undefined }],
        { title: 'Hermes provider', placeHolder: 'Edit a profile or create a new one' },
      );
      if (!picked) return undefined;
      base = picked.profile;
    }

    let draft: Partial<ProviderProfile> = { ...base };
    for (let round = 0; round < 5; round += 1) {
      const collected = await this.collect(draft, Boolean(base));
      if (!collected) return undefined;
      draft = collected.profile;
      const profile: ProviderProfile = {
        id: base?.id ?? newProfileId(String(draft.name)),
        name: String(draft.name), baseUrl: String(draft.baseUrl), model: String(draft.model),
        timeoutSeconds: draft.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
        allowInsecureHttp: draft.allowInsecureHttp,
      };
      const key = collected.apiKey ?? (base ? await this.store.apiKey(base.id) : undefined);
      registerSecret(key);

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Hermes: testing ${profile.name}` },
        () => testConnection(profile, key),
      );
      this.log(`[provider] connection test for "${profile.name}":\n${summarize(result)}`);
      if (!result.ok) {
        const save = 'Save anyway';
        const edit = 'Edit';
        const choice = await vscode.window.showWarningMessage(
          `The connection test failed.\n\n${summarize(result)}`, { modal: true }, save, edit,
        );
        if (choice === edit) continue;
        if (choice !== save) return undefined;
      } else {
        void vscode.window.showInformationMessage(`Provider "${profile.name}" works.`);
      }
      await this.store.save(profile, collected.apiKey);
      await this.store.setActive(profile.id);
      return profile;
    }
    return undefined;
  }

  private async collect(
    draft: Partial<ProviderProfile>,
    editing: boolean,
  ): Promise<{ profile: Partial<ProviderProfile>; apiKey?: string } | undefined> {
    const name = await vscode.window.showInputBox({
      title: 'Hermes provider (1/4): profile name', value: draft.name ?? 'My provider', ignoreFocusOut: true,
      validateInput: (v) => validateProfile({ name: v, model: 'x', baseUrl: 'https://x' }).find((m) => /name/i.test(m)),
    });
    if (name === undefined) return undefined;

    const baseUrl = await vscode.window.showInputBox({
      title: 'Hermes provider (2/4): base URL', prompt: 'OpenAI-compatible endpoint, for example https://api.example.com/v1',
      value: draft.baseUrl ?? '', ignoreFocusOut: true,
      validateInput: (v) => validateProfile({ name: 'x', model: 'x', baseUrl: v, allowInsecureHttp: true }).find((m) => /URL/i.test(m)),
    });
    if (baseUrl === undefined) return undefined;

    let allowInsecureHttp = draft.allowInsecureHttp;
    try {
      const u = new URL(normalizeBaseUrl(baseUrl));
      if (u.protocol === 'http:' && !isLoopbackHost(u.hostname) && !allowInsecureHttp) {
        const allow = 'Allow insecure HTTP';
        const choice = await vscode.window.showWarningMessage(
          'This URL uses plain HTTP. Your prompts and API key would travel unencrypted over the network.',
          { modal: true }, allow,
        );
        if (choice !== allow) return undefined;
        allowInsecureHttp = true;
      }
    } catch { /* validateInput already caught it */ }

    const model = await vscode.window.showInputBox({
      title: 'Hermes provider (3/4): model', prompt: 'Model id exactly as the provider lists it',
      value: draft.model ?? '', ignoreFocusOut: true,
      validateInput: (v) => validateProfile({ name: 'x', model: v, baseUrl: 'https://x' }).find((m) => /model/i.test(m)),
    });
    if (model === undefined) return undefined;

    const loopback = (() => { try { return isLoopbackHost(new URL(normalizeBaseUrl(baseUrl)).hostname); } catch { return false; } })();
    const apiKey = await vscode.window.showInputBox({
      title: 'Hermes provider (4/4): API key',
      prompt: editing ? 'Leave empty to keep the stored key.' : (loopback ? 'Optional for a local endpoint.' : 'Stored in VS Code Secret Storage, never in settings or files.'),
      password: true, ignoreFocusOut: true,
      validateInput: (v) => (!editing && !loopback && !v ? 'Enter the API key.' : undefined),
    });
    if (apiKey === undefined) return undefined;

    return {
      profile: { ...draft, name: name.trim(), baseUrl: normalizeBaseUrl(baseUrl), model: model.trim(), allowInsecureHttp },
      apiKey: apiKey === '' ? undefined : apiKey,
    };
  }

  /** Tests the active profile again, for the "Test Provider Connection" command. */
  async testActive(): Promise<void> {
    const profile = this.store.active();
    if (!profile) {
      const go = await vscode.window.showInformationMessage('No provider is configured yet.', 'Configure now');
      if (go) await this.configure();
      return;
    }
    const key = await this.store.apiKey(profile.id);
    registerSecret(key);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Hermes: testing ${profile.name}` },
      () => testConnection(profile, key),
    );
    this.log(`[provider] connection test for "${profile.name}":\n${summarize(result)}`);
    if (result.ok) void vscode.window.showInformationMessage(`Provider "${profile.name}" works.\n${summarize(result)}`);
    else {
      const pick = await vscode.window.showErrorMessage(`Provider "${profile.name}" failed.\n${summarize(result)}`, 'Open Provider Settings');
      if (pick) await vscode.commands.executeCommand(`${NS}.configureProvider`);
    }
  }
}
