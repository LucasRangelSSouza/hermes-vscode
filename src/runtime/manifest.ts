import * as fs from 'fs';
import * as path from 'path';

export interface PackEntry {
  name: string;
  file: string;
  bytes: number;
  sha256: string;
  required: boolean;
  url: string;
}

export interface PlatformRuntime {
  id: string;
  platform: string;
  hermes: { ref: string; commit: string };
  packs: PackEntry[];
}

export interface RuntimeManifest {
  schema: 1;
  runtimes: Record<string, PlatformRuntime>;
}

/** Only these hosts may serve runtime bytes. Runtime downloads never accept an arbitrary URL. */
export const TRUSTED_RELEASE_PREFIX = 'https://github.com/LucasRangelSSouza/hermes-vscode/releases/download/';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

export class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(`Invalid runtime manifest: ${message}`);
}

function parsePack(raw: unknown, trustedPrefix: string): PackEntry {
  if (!raw || typeof raw !== 'object') fail('pack is not an object');
  const p = raw as Record<string, unknown>;
  const { name, file, bytes, sha256, required, url } = p;
  if (typeof name !== 'string' || !NAME_RE.test(name)) fail(`bad pack name ${String(name)}`);
  if (typeof file !== 'string' || !FILE_RE.test(file)) fail(`bad file name for pack ${name}`);
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) fail(`bad size for pack ${name}`);
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) fail(`bad sha256 for pack ${name}`);
  if (typeof required !== 'boolean') fail(`bad required flag for pack ${name}`);
  if (typeof url !== 'string' || !url.startsWith(trustedPrefix)) fail(`untrusted url for pack ${name}`);
  if (path.posix.basename(url) !== file) fail(`url does not end with the file name for pack ${name}`);
  return { name, file, bytes, sha256, required, url };
}

export function parseRuntimeManifest(
  raw: unknown,
  trustedPrefix: string = TRUSTED_RELEASE_PREFIX,
): RuntimeManifest {
  if (!raw || typeof raw !== 'object') fail('not an object');
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== 1) fail('unsupported schema');
  if (!doc.runtimes || typeof doc.runtimes !== 'object') fail('missing runtimes');
  const runtimes: Record<string, PlatformRuntime> = {};
  for (const [key, value] of Object.entries(doc.runtimes as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') fail(`runtime ${key} is not an object`);
    const r = value as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ID_RE.test(r.id)) fail(`bad id for ${key}`);
    if (typeof r.platform !== 'string' || r.platform !== key) fail(`platform mismatch for ${key}`);
    const hermes = r.hermes as Record<string, unknown> | undefined;
    if (!hermes || typeof hermes.ref !== 'string' || typeof hermes.commit !== 'string') fail(`bad hermes info for ${key}`);
    if (!Array.isArray(r.packs) || r.packs.length === 0) fail(`no packs for ${key}`);
    const packs = r.packs.map((p) => parsePack(p, trustedPrefix));
    const names = new Set<string>();
    for (const p of packs) {
      if (names.has(p.name)) fail(`duplicate pack ${p.name} for ${key}`);
      names.add(p.name);
    }
    if (!packs.some((p) => p.name === 'core' && p.required)) fail(`${key} has no required core pack`);
    runtimes[key] = {
      id: r.id, platform: r.platform,
      hermes: { ref: hermes.ref as string, commit: hermes.commit as string },
      packs,
    };
  }
  return { schema: 1, runtimes };
}

export function loadEmbeddedManifest(extensionPath: string): RuntimeManifest {
  const file = path.join(extensionPath, 'runtime-manifest', 'manifest.json');
  return parseRuntimeManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function platformKey(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function runtimeForPlatform(manifest: RuntimeManifest, key: string = platformKey()): PlatformRuntime | null {
  return manifest.runtimes[key] ?? null;
}

/** Core plus the requested optional packs, in manifest order. Unknown names are ignored. */
export function selectPacks(runtime: PlatformRuntime, optional: readonly string[]): PackEntry[] {
  const wanted = new Set(optional);
  return runtime.packs.filter((p) => p.required || wanted.has(p.name));
}

export function totalBytes(packs: readonly PackEntry[]): number {
  return packs.reduce((sum, p) => sum + p.bytes, 0);
}
