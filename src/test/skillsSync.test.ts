import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { fetchCommitSha, GithubError, GITHUB_POLICY, parseRepoRef } from '../skills/github';
import type { UrlPolicy } from '../skills/github';
import { detectLocalChanges, extractSkills, mirrorLayout, readState } from '../skills/mirror';
import { applySkillsDir, SkillsSyncError, syncSkills } from '../skills/sync';
import type { CommandRunner } from '../providers/configWriter';

const OPEN: UrlPolicy = { isAllowed: () => true };
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

async function buildTarball(dir: string, files: Record<string, string>): Promise<Buffer> {
  const wrapper = 'owner-repo-abc1234';
  const src = fs.mkdtempSync(path.join(dir, 'tb-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(src, wrapper, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const out = path.join(dir, `tb-${Math.random().toString(16).slice(2)}.tar.gz`);
  await tar.c({ gzip: true, file: out, cwd: src }, [wrapper]);
  return fs.readFileSync(out);
}

interface Fake {
  root: string;
  api: string;
  requests: { api: Array<{ url: string; auth?: string }>; dl: Array<{ url: string; auth?: string }> };
  state: { sha: string; tarball: Buffer; token?: string; missing?: boolean; rateLimited?: boolean };
  close: () => Promise<void>;
}

async function fake(): Promise<Fake> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-skills-'));
  const requests: Fake['requests'] = { api: [], dl: [] };
  const state: Fake['state'] = { sha: SHA1, tarball: Buffer.alloc(0) };
  const dl = http.createServer((req, res) => {
    requests.dl.push({ url: req.url ?? '', auth: req.headers.authorization });
    res.end(state.tarball);
  });
  await new Promise<void>((r) => dl.listen(0, '127.0.0.1', r));
  const dlPort = (dl.address() as AddressInfo).port;
  const api = http.createServer((req, res) => {
    requests.api.push({ url: req.url ?? '', auth: req.headers.authorization });
    if (state.rateLimited) { res.statusCode = 403; res.setHeader('x-ratelimit-remaining', '0'); res.end(); return; }
    if (state.token && req.headers.authorization !== `Bearer ${state.token}`) { res.statusCode = state.missing ? 404 : 401; res.end(); return; }
    if (state.missing) { res.statusCode = 404; res.end(); return; }
    if ((req.url ?? '').includes('/commits/')) { res.end(state.sha); return; }
    if ((req.url ?? '').includes('/tarball/')) { res.statusCode = 302; res.setHeader('location', `http://127.0.0.1:${dlPort}/codeload/owner/repo.tar.gz`); res.end(); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const apiPort = (api.address() as AddressInfo).port;
  return {
    root, api: `http://127.0.0.1:${apiPort}`, requests, state,
    close: async () => {
      await new Promise<void>((r) => api.close(() => r()));
      await new Promise<void>((r) => dl.close(() => r()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const repo = { owner: 'owner', repo: 'repo' };
const FILES = {
  'README.md': '# repo',
  'skills/coding/git/SKILL.md': '---\nname: git\ndescription: git\n---\n# git',
  'skills/terraform/SKILL.md': '---\nname: tf\ndescription: tf\n---\n# tf',
  'other/ignored.txt': 'nope',
};

test('parses owner/repo and GitHub URLs', () => {
  assert.deepEqual(parseRepoRef('owner/repo'), repo);
  assert.deepEqual(parseRepoRef('https://github.com/owner/repo'), repo);
  assert.deepEqual(parseRepoRef('https://github.com/owner/repo.git'), repo);
  assert.deepEqual(parseRepoRef('https://github.com/owner/repo/tree/main/skills'), repo);
  assert.equal(parseRepoRef('not a repo'), null);
  assert.equal(parseRepoRef('https://evil.example/owner/repo'), null);
  assert.equal(parseRepoRef('owner/../etc'), null);
});

test('explains missing, unauthorized and rate limited responses', async () => {
  const f = await fake();
  try {
    f.state.missing = true;
    await assert.rejects(fetchCommitSha(repo, 'main', { apiBase: f.api, policy: OPEN }), (e: unknown) => e instanceof GithubError && /not found/.test(e.message) && /token/.test(e.message));
    f.state.missing = false; f.state.token = 'good-token-value';
    await assert.rejects(fetchCommitSha(repo, 'main', { apiBase: f.api, policy: OPEN, token: 'bad' }), (e: unknown) => e instanceof GithubError && e.status === 401);
    assert.equal(await fetchCommitSha(repo, 'main', { apiBase: f.api, policy: OPEN, token: 'good-token-value' }), SHA1);
    f.state.rateLimited = true;
    await assert.rejects(fetchCommitSha(repo, 'main', { apiBase: f.api, policy: OPEN }), (e: unknown) => e instanceof GithubError && /rate limit/i.test(e.message));
  } finally { await f.close(); }
});

test('the default policy refuses hosts that are not GitHub', async () => {
  await assert.rejects(fetchCommitSha(repo, 'main', { apiBase: 'https://evil.example' }), (e: unknown) => e instanceof GithubError && /not a GitHub host/.test(e.message));
  assert.equal(GITHUB_POLICY.isAllowed(new URL('https://api.github.com/x')), true);
  assert.equal(GITHUB_POLICY.isAllowed(new URL('https://codeload.github.com/x')), true);
  assert.equal(GITHUB_POLICY.isAllowed(new URL('http://api.github.com/x')), false);
  assert.equal(GITHUB_POLICY.isAllowed(new URL('https://github.com.evil.example/x')), false);
});

test('mirrors only the skills folder and sends the token to the API host only', async () => {
  const f = await fake();
  try {
    f.state.token = 'private-token-123456';
    f.state.tarball = await buildTarball(f.root, FILES);
    const out = await syncSkills({ reposRoot: path.join(f.root, 'repos'), repo, branch: 'main', skillsPath: 'skills', apiBase: f.api, policy: OPEN, token: 'private-token-123456' });
    assert.equal(out.state, 'updated');
    assert.equal(out.files, 2);
    assert.equal(fs.readFileSync(path.join(out.mirror, 'coding', 'git', 'SKILL.md'), 'utf8').includes('name: git'), true);
    assert.ok(!fs.existsSync(path.join(out.mirror, 'README.md')), 'files outside the skills path are not mirrored');
    assert.ok(!fs.existsSync(path.join(out.mirror, 'other')));
    assert.ok(f.requests.api.every((r) => r.auth === 'Bearer private-token-123456'));
    assert.ok(f.requests.dl.length === 1 && f.requests.dl.every((r) => r.auth === undefined), 'the signed download host must never see the token');
    assert.equal(readState(mirrorLayout(path.join(f.root, 'repos'), 'owner', 'repo').state)?.commit, SHA1);
  } finally { await f.close(); }
});

test('an unchanged commit downloads nothing', async () => {
  const f = await fake();
  try {
    f.state.tarball = await buildTarball(f.root, FILES);
    const req = { reposRoot: path.join(f.root, 'repos'), repo, branch: 'main', skillsPath: 'skills', apiBase: f.api, policy: OPEN };
    await syncSkills(req);
    const dlBefore = f.requests.dl.length;
    const again = await syncSkills(req);
    assert.equal(again.state, 'unchanged');
    assert.equal(f.requests.dl.length, dlBefore);
  } finally { await f.close(); }
});

test('a new commit replaces the mirror and drops removed skills', async () => {
  const f = await fake();
  try {
    const req = { reposRoot: path.join(f.root, 'repos'), repo, branch: 'main', skillsPath: 'skills', apiBase: f.api, policy: OPEN };
    f.state.tarball = await buildTarball(f.root, FILES);
    await syncSkills(req);
    f.state.sha = SHA2;
    f.state.tarball = await buildTarball(f.root, { 'skills/coding/git/SKILL.md': '---\nname: git\ndescription: v2\n---\n', 'skills/new/SKILL.md': '---\nname: new\ndescription: n\n---\n' });
    const out = await syncSkills(req);
    assert.equal(out.state, 'updated');
    assert.ok(fs.existsSync(path.join(out.mirror, 'new', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(out.mirror, 'terraform')), 'a skill removed upstream disappears from the mirror');
    assert.match(fs.readFileSync(path.join(out.mirror, 'coding', 'git', 'SKILL.md'), 'utf8'), /v2/);
  } finally { await f.close(); }
});

test('hand edits are never overwritten silently', async () => {
  const f = await fake();
  try {
    const req = { reposRoot: path.join(f.root, 'repos'), repo, branch: 'main', skillsPath: 'skills', apiBase: f.api, policy: OPEN };
    f.state.tarball = await buildTarball(f.root, FILES);
    const first = await syncSkills(req);
    const edited = path.join(first.mirror, 'coding', 'git', 'SKILL.md');
    fs.writeFileSync(edited, 'my local edit');
    const layout = mirrorLayout(req.reposRoot, 'owner', 'repo');
    assert.deepEqual(detectLocalChanges(layout.mirror, readState(layout.state)!), ['coding/git/SKILL.md']);

    f.state.sha = SHA2;
    f.state.tarball = await buildTarball(f.root, FILES);
    const kept = await syncSkills(req);
    assert.equal(kept.state, 'cancelled');
    assert.equal(fs.readFileSync(edited, 'utf8'), 'my local edit');

    const asked: string[][] = [];
    const overwritten = await syncSkills({ ...req, onLocalChanges: async (changed) => { asked.push(changed); return 'overwrite'; } });
    assert.equal(overwritten.state, 'updated');
    assert.deepEqual(asked, [['coding/git/SKILL.md']]);
    assert.notEqual(fs.readFileSync(edited, 'utf8'), 'my local edit');
  } finally { await f.close(); }
});

test('a wrong skills path fails clearly and keeps the previous mirror', async () => {
  const f = await fake();
  try {
    const base = { reposRoot: path.join(f.root, 'repos'), repo, branch: 'main', apiBase: f.api, policy: OPEN };
    f.state.tarball = await buildTarball(f.root, FILES);
    const ok = await syncSkills({ ...base, skillsPath: 'skills' });
    f.state.sha = SHA2;
    await assert.rejects(syncSkills({ ...base, skillsPath: 'nope' }), (e: unknown) => e instanceof SkillsSyncError && /skills path/.test(e.message));
    assert.ok(fs.existsSync(path.join(ok.mirror, 'coding', 'git', 'SKILL.md')));
    await assert.rejects(syncSkills({ ...base, skillsPath: '../etc' }), /inside the repository/);
  } finally { await f.close(); }
});

test('extraction stays inside the staging folder', async () => {
  const f = await fake();
  try {
    const tb = await buildTarball(f.root, { 'skills/a/SKILL.md': 'x' });
    const file = path.join(f.root, 'x.tar.gz');
    fs.writeFileSync(file, tb);
    const staging = path.join(f.root, 'staging');
    assert.equal(await extractSkills(file, staging, 'skills'), 1);
    assert.ok(fs.existsSync(path.join(staging, 'a', 'SKILL.md')));
  } finally { await f.close(); }
});

test('points Hermes at the mirror once and writes a JSON list with forward slashes', async () => {
  const f = await fake();
  try {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_e, args) => { calls.push(args); fs.writeFileSync(path.join(f.root, 'config.yaml'), 'x'); return { code: 0, stdout: '', stderr: '', timedOut: false }; };
    const req = { cliExe: 'hermes', hermesHome: f.root, statePath: path.join(f.root, 'state', 'skills-dir.json'), mirrorDir: 'C:\\Users\\a\\skills\\mirror', runner };
    assert.equal(await applySkillsDir(req), true);
    assert.deepEqual(calls[0], ['config', 'set', 'skills.external_dirs', '["C:/Users/a/skills/mirror"]']);
    assert.equal(await applySkillsDir(req), false);
    assert.equal(calls.length, 1);
    assert.equal(await applySkillsDir({ ...req, mirrorDir: 'C:\\other' }), true);
  } finally { await f.close(); }
});
