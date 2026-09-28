/** A provider profile never contains a secret. The API key lives in SecretStorage, keyed by the profile id. */
export interface ProviderProfile {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  allowInsecureHttp?: boolean;
}

export const DEFAULT_TIMEOUT_SECONDS = 60;

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost');
}

/** Returns a list of problems. Empty means the profile is usable. */
export function validateProfile(p: Partial<ProviderProfile>): string[] {
  const problems: string[] = [];
  if (!p.name || !p.name.trim()) problems.push('Give the profile a name.');
  else if (p.name.trim().length > 60) problems.push('The profile name is too long (60 characters maximum).');
  if (!p.model || !p.model.trim() || /[\s\u0000-\u001f]/.test(p.model.trim())) {
    problems.push('Enter the model id exactly as the provider lists it (no spaces).');
  }
  if (!p.baseUrl || !p.baseUrl.trim()) {
    problems.push('Enter the base URL, for example https://api.example.com/v1.');
  } else {
    let url: URL | null = null;
    try { url = new URL(normalizeBaseUrl(p.baseUrl)); } catch { problems.push('The base URL is not a valid URL.'); }
    if (url) {
      if (url.username || url.password) problems.push('Do not put credentials in the URL. Use the API key field.');
      if (url.protocol !== 'https:' && url.protocol !== 'http:') problems.push('The base URL must start with https://.');
      if (url.protocol === 'http:' && !isLoopbackHost(url.hostname) && !p.allowInsecureHttp) {
        problems.push('Plain http:// is only allowed for localhost. Use https://, or explicitly allow insecure HTTP for this profile.');
      }
    }
  }
  const t = p.timeoutSeconds;
  if (t !== undefined && (!Number.isFinite(t) || t < 5 || t > 600)) problems.push('The timeout must be between 5 and 600 seconds.');
  return problems;
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug || 'profile').slice(0, 24);
}

export function newProfileId(name: string, random: () => number = Math.random): string {
  const suffix = Math.floor(random() * 0xffff).toString(16).padStart(4, '0');
  return `${slugify(name)}-${suffix}`;
}

/** Name of the process environment variable that carries the key of one profile into Hermes. */
export function apiKeyEnvName(id: string): string {
  return `HERMES_RT_KEY_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

export function secretKeyFor(id: string): string {
  return `hermesRangelTech/profile/${id}/apiKey`;
}

/** Minimal shape of VS Code's Memento, so this module stays free of the vscode import. */
export interface KeyValueStore {
  get<T>(key: string, fallback: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Minimal shape of VS Code's SecretStorage. */
export interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

const PROFILES_KEY = 'hermesRangelTech.providerProfiles';
const ACTIVE_KEY = 'hermesRangelTech.activeProviderProfile';

export class ProfileStore {
  constructor(private readonly state: KeyValueStore, private readonly secrets: SecretStore) {}

  list(): ProviderProfile[] {
    return this.state.get<ProviderProfile[]>(PROFILES_KEY, []);
  }

  get(id: string): ProviderProfile | undefined {
    return this.list().find((p) => p.id === id);
  }

  activeId(): string | undefined {
    const id = this.state.get<string | undefined>(ACTIVE_KEY, undefined);
    return id && this.get(id) ? id : this.list()[0]?.id;
  }

  active(): ProviderProfile | undefined {
    const id = this.activeId();
    return id ? this.get(id) : undefined;
  }

  async save(profile: ProviderProfile, apiKey?: string): Promise<void> {
    const problems = validateProfile(profile);
    if (problems.length) throw new Error(problems[0]);
    const clean: ProviderProfile = { ...profile, baseUrl: normalizeBaseUrl(profile.baseUrl), name: profile.name.trim(), model: profile.model.trim() };
    const others = this.list().filter((p) => p.id !== clean.id);
    await this.state.update(PROFILES_KEY, [...others, clean]);
    if (apiKey !== undefined) await this.secrets.store(secretKeyFor(clean.id), apiKey);
    if (!this.state.get<string | undefined>(ACTIVE_KEY, undefined)) await this.state.update(ACTIVE_KEY, clean.id);
  }

  async setActive(id: string): Promise<void> {
    if (!this.get(id)) throw new Error('Unknown provider profile.');
    await this.state.update(ACTIVE_KEY, id);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(PROFILES_KEY, this.list().filter((p) => p.id !== id));
    await this.secrets.delete(secretKeyFor(id));
    if (this.state.get<string | undefined>(ACTIVE_KEY, undefined) === id) await this.state.update(ACTIVE_KEY, undefined);
  }

  apiKey(id: string): PromiseLike<string | undefined> {
    return this.secrets.get(secretKeyFor(id));
  }
}
