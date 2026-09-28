import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildRuntimeEnv, runCapture } from '../runtime/process';
import type { CaptureResult } from '../runtime/process';
import { apiKeyEnvName, normalizeBaseUrl } from './profile';
import type { ProviderProfile } from './profile';

/** `hermes config set` arguments for one profile. The key is referenced as ${VAR}, never written. */
export function configCommands(profile: ProviderProfile): string[][] {
  const env = apiKeyEnvName(profile.id);
  return [
    ['config', 'set', 'model.provider', 'custom'],
    ['config', 'set', 'model.base_url', normalizeBaseUrl(profile.baseUrl)],
    ['config', 'set', 'model.default', profile.model],
    ['config', 'set', 'model.api_key', '${' + env + '}'],
  ];
}

export function profileFingerprint(profile: ProviderProfile): string {
  return crypto
    .createHash('sha256')
    .update([normalizeBaseUrl(profile.baseUrl), profile.model, apiKeyEnvName(profile.id)].join('\n'))
    .digest('hex');
}

export type CommandRunner = (exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<CaptureResult>;

export interface ApplyRequest {
  cliExe: string;
  hermesHome: string;
  /** Where the fingerprint of the last applied profile is remembered. */
  statePath: string;
  profile: ProviderProfile;
  baseEnv?: NodeJS.ProcessEnv;
  runner?: CommandRunner;
  /** Apply again even when nothing changed. */
  force?: boolean;
}

export class ConfigApplyError extends Error {}

/**
 * Writes the profile into the private Hermes home through Hermes's own CLI, so its schema and
 * migrations stay authoritative. The API key variable is deliberately absent from this process's
 * environment, so the placeholder is stored literally instead of being expanded to the secret.
 */
export async function applyProfile(req: ApplyRequest): Promise<boolean> {
  const fingerprint = profileFingerprint(req.profile);
  const configFile = path.join(req.hermesHome, 'config.yaml');
  if (!req.force && fs.existsSync(configFile)) {
    try {
      const saved = JSON.parse(fs.readFileSync(req.statePath, 'utf8')) as { fingerprint?: string };
      if (saved.fingerprint === fingerprint) return false;
    } catch { /* not applied yet */ }
  }
  fs.mkdirSync(req.hermesHome, { recursive: true });
  const env = buildRuntimeEnv(req.baseEnv ?? process.env, { hermesHome: req.hermesHome });
  delete env[apiKeyEnvName(req.profile.id)];
  const run = req.runner ?? runCapture;
  for (const args of configCommands(req.profile)) {
    const result = await run(req.cliExe, args, env, 60000);
    if (result.spawnError || result.timedOut || result.code !== 0) {
      throw new ConfigApplyError(
        `Could not write the provider settings (${args.slice(0, 3).join(' ')}): ${(result.spawnError ?? result.stderr ?? result.stdout).toString().trim().slice(0, 300)}`,
      );
    }
  }
  fs.mkdirSync(path.dirname(req.statePath), { recursive: true });
  fs.writeFileSync(req.statePath, JSON.stringify({ fingerprint, appliedAt: new Date().toISOString() }));
  return true;
}
