import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { buildRuntimeEnv, runCapture } from './process';

export interface RuntimeJson {
  schema: 1;
  id: string;
  hermes: { ref: string; commit: string };
  platform: string;
  arch: string;
  acpProtocolVersion: number;
  entry: { exe: string; args: string[] };
  cli: { exe: string };
}

export interface ValidatedRuntime {
  dir: string;
  json: RuntimeJson;
  entryExe: string;
  entryArgs: string[];
  cliExe: string;
  version: string;
}

export type ValidationStep = 'runtime.json' | 'platform' | 'entry' | 'version' | 'check';

/** A validation failure carries what the user needs to ask IT for an exception (product spec section 25). */
export class RuntimeValidationError extends Error {
  constructor(
    readonly step: ValidationStep,
    message: string,
    readonly exePath?: string,
    readonly exeSha256?: string,
  ) {
    super(message);
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function isSafeRelative(p: string): boolean {
  if (!p || path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]+/).includes('..');
}

export function readRuntimeJson(dir: string): RuntimeJson {
  const file = path.join(dir, 'runtime.json');
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new RuntimeValidationError('runtime.json', `runtime.json is missing or unreadable in ${dir}: ${err instanceof Error ? err.message : err}`);
  }
  if (!doc || typeof doc !== 'object') throw new RuntimeValidationError('runtime.json', 'runtime.json is not an object');
  const d = doc as Record<string, unknown>;
  const entry = d.entry as Record<string, unknown> | undefined;
  const cli = d.cli as Record<string, unknown> | undefined;
  const hermes = d.hermes as Record<string, unknown> | undefined;
  if (d.schema !== 1 || typeof d.id !== 'string' || typeof d.platform !== 'string' || typeof d.arch !== 'string'
    || !entry || typeof entry.exe !== 'string' || !Array.isArray(entry.args)
    || !cli || typeof cli.exe !== 'string' || !hermes) {
    throw new RuntimeValidationError('runtime.json', 'runtime.json has an unexpected shape');
  }
  if (!isSafeRelative(entry.exe) || !isSafeRelative(cli.exe)) {
    throw new RuntimeValidationError('runtime.json', 'runtime.json paths must be relative and stay inside the runtime folder');
  }
  return {
    schema: 1,
    id: d.id,
    hermes: { ref: String(hermes.ref ?? ''), commit: String(hermes.commit ?? '') },
    platform: d.platform,
    arch: d.arch,
    acpProtocolVersion: typeof d.acpProtocolVersion === 'number' ? d.acpProtocolVersion : 1,
    entry: { exe: entry.exe, args: entry.args.map(String) },
    cli: { exe: cli.exe },
  };
}

export interface ValidateOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  /** Skip spawning the runtime (used only for structural checks). */
  structuralOnly?: boolean;
  timeoutMs?: number;
  hermesHome: string;
  baseEnv?: NodeJS.ProcessEnv;
}

async function fail(step: ValidationStep, message: string, exe: string | undefined): Promise<never> {
  let hash: string | undefined;
  if (exe) {
    try { hash = await sha256File(exe); } catch { /* the file may not exist */ }
  }
  throw new RuntimeValidationError(step, message, exe, hash);
}

/**
 * Validation order, first failure stops: runtime.json, platform, entry executable, `--version`, `--check`.
 * The same routine validates managed installs and portable folders.
 */
export async function validateRuntime(dir: string, opts: ValidateOptions): Promise<ValidatedRuntime> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const json = readRuntimeJson(dir);
  if (json.platform !== platform || json.arch !== arch) {
    throw new RuntimeValidationError('platform', `This runtime is for ${json.platform}-${json.arch}, but this machine is ${platform}-${arch}.`);
  }
  const entryExe = path.join(dir, ...json.entry.exe.split('/'));
  const cliExe = path.join(dir, ...json.cli.exe.split('/'));
  if (!fs.existsSync(entryExe)) await fail('entry', `The runtime entry executable is missing: ${entryExe}`, undefined);
  if (opts.structuralOnly) {
    return { dir, json, entryExe, entryArgs: json.entry.args, cliExe, version: '' };
  }
  const env = buildRuntimeEnv(opts.baseEnv ?? process.env, { hermesHome: opts.hermesHome });
  const timeout = opts.timeoutMs ?? 30000;
  const ver = await runCapture(entryExe, [...json.entry.args, '--version'], env, Math.min(timeout, 10000), dir);
  if (ver.spawnError || ver.timedOut || ver.code !== 0) {
    await fail('version', ver.timedOut
      ? 'Starting the runtime timed out. Endpoint security may be scanning or blocking it.'
      : `The runtime did not start${ver.spawnError ? `: ${ver.spawnError}` : ` (exit code ${ver.code})`}. ${ver.stderr.trim().slice(0, 400)}`, entryExe);
  }
  const check = await runCapture(entryExe, [...json.entry.args, '--check'], env, timeout, dir);
  if (check.spawnError || check.timedOut || check.code !== 0 || !/Hermes ACP check OK/.test(check.stdout)) {
    await fail('check', `The runtime failed its ACP self-check${check.timedOut ? ' (timed out)' : ` (exit code ${check.code})`}. ${(check.stderr || check.stdout).trim().slice(0, 400)}`, entryExe);
  }
  return { dir, json, entryExe, entryArgs: json.entry.args, cliExe, version: ver.stdout.trim() };
}
