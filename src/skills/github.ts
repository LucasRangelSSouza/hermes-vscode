import * as fs from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

export interface RepoRef {
  owner: string;
  repo: string;
}

export class GithubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface UrlPolicy {
  isAllowed(url: URL): boolean;
}

export const GITHUB_POLICY: UrlPolicy = {
  isAllowed: (u) => u.protocol === 'https:'
    && (u.hostname === 'api.github.com' || u.hostname === 'github.com' || u.hostname === 'codeload.github.com'
      || u.hostname.endsWith('.githubusercontent.com')),
};

export interface GithubOptions {
  apiBase?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  policy?: UrlPolicy;
  signal?: AbortSignal;
}

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_])?$/;

/** Accepts `owner/repo` or a github.com URL (with .git or /tree/... suffixes). */
export function parseRepoRef(input: string): RepoRef | null {
  const text = input.trim();
  const m = /^(?:https:\/\/github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/.*)?$/.exec(text);
  if (!m) return null;
  const [, owner, repo] = m;
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  return { owner, repo };
}

function authHeaders(url: URL, base: URL, token: string | undefined): Record<string, string> {
  // The token goes to the API host only, never to the signed download host it redirects to.
  return token && url.host === base.host ? { authorization: `Bearer ${token}` } : {};
}

async function get(
  url: string,
  headers: Record<string, string>,
  opts: GithubOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const policy = opts.policy ?? GITHUB_POLICY;
  const base = new URL(opts.apiBase ?? 'https://api.github.com');
  let current = url;
  for (let hop = 0; hop < 6; hop += 1) {
    const parsed = new URL(current);
    if (!policy.isAllowed(parsed)) throw new GithubError(`Refusing to contact ${parsed.origin}: not a GitHub host.`);
    const res = await fetchImpl(current, {
      headers: { 'user-agent': 'hermes-by-rangel-tech', ...headers, ...authHeaders(parsed, base, opts.token) },
      redirect: 'manual',
      signal: opts.signal,
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) throw new GithubError('GitHub redirected without a location.', res.status);
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
  throw new GithubError('Too many redirects from GitHub.');
}

function explain(res: Response, ref: RepoRef, branch: string, hadToken: boolean): GithubError {
  if (res.status === 401) return new GithubError('GitHub rejected the token (HTTP 401). Check that it is valid and has not expired.', 401);
  if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
    return new GithubError('GitHub rate limit reached. Add a token to the skills settings or try again later.', 403);
  }
  if (res.status === 403) return new GithubError('GitHub returned HTTP 403. Check the token has read access to the repository contents.', 403);
  if (res.status === 404) {
    return new GithubError(
      `${ref.owner}/${ref.repo} at "${branch}" was not found${hadToken ? ' or the token cannot read it' : '. For a private repository, add a token'}.`,
      404,
    );
  }
  return new GithubError(`GitHub returned HTTP ${res.status}.`, res.status);
}

/** Latest commit SHA of a branch. One small request, used to skip downloads when nothing changed. */
export async function fetchCommitSha(ref: RepoRef, branch: string, opts: GithubOptions = {}): Promise<string> {
  const base = opts.apiBase ?? 'https://api.github.com';
  const url = `${base}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await get(url, { accept: 'application/vnd.github.sha' }, opts);
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(`Could not reach GitHub: ${(err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message}`);
  }
  if (!res.ok) throw explain(res, ref, branch, Boolean(opts.token));
  const sha = (await res.text()).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GithubError('GitHub returned an unexpected commit identifier.');
  return sha;
}

/** Streams the repository tarball of one branch into a file. */
export async function downloadTarball(ref: RepoRef, branch: string, file: string, opts: GithubOptions = {}): Promise<void> {
  const base = opts.apiBase ?? 'https://api.github.com';
  const url = `${base}/repos/${ref.owner}/${ref.repo}/tarball/${encodeURIComponent(branch)}`;
  let res: Response;
  try {
    res = await get(url, {}, opts);
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(`Could not reach GitHub: ${(err as { cause?: { message?: string } }).cause?.message ?? (err as Error).message}`);
  }
  if (!res.ok || !res.body) throw explain(res, ref, branch, Boolean(opts.token));
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(file));
}
