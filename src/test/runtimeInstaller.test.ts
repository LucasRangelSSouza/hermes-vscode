import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { dataPaths } from '../paths/hermesHome';
import {
  DownloadError, IntegrityError, InstallLockedError, STRICT_POLICY, acquireInstallLock, installRuntime, readActive,
} from '../runtime/installer';
import type { UrlPolicy } from '../runtime/installer';
import type { PackEntry, PlatformRuntime } from '../runtime/manifest';

const OPEN_POLICY: UrlPolicy = { isAllowed: () => true };

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function makeTarGz(dir: string, name: string, files: Record<string, string>): Promise<Buffer> {
  const src = fs.mkdtempSync(path.join(dir, `src-${name}-`));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(src, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const out = path.join(dir, `${name}.tar.gz`);
  await tar.c({ gzip: true, file: out, cwd: src }, fs.readdirSync(src));
  return fs.readFileSync(out);
}

interface Fixture {
  root: string;
  paths: ReturnType<typeof dataPaths>;
  base: string;
  close: () => Promise<void>;
  requests: Array<{ url: string; range?: string }>;
  runtime: (packs: Array<{ name: string; buf: Buffer; required?: boolean; tamper?: boolean }>) => PlatformRuntime;
  serve: (name: string, buf: Buffer, opts?: { dropAfter?: number; ignoreRange?: boolean }) => void;
}

async function fixture(): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-inst-'));
  const served = new Map<string, { buf: Buffer; dropAfter?: number; ignoreRange?: boolean; drops: number }>();
  const requests: Array<{ url: string; range?: string }> = [];
  const server = http.createServer((req, res) => {
    const name = (req.url ?? '').replace(/^\//, '');
    requests.push({ url: req.url ?? '', range: req.headers.range });
    const entry = served.get(name);
    if (!entry) { res.statusCode = 404; res.end(); return; }
    let start = 0;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m && !entry.ignoreRange) start = Number(m[1]);
    const body = entry.buf.subarray(start);
    res.statusCode = start > 0 ? 206 : 200;
    res.setHeader('content-length', String(body.length));
    if (entry.dropAfter !== undefined && entry.drops === 0) {
      entry.drops += 1;
      res.write(body.subarray(0, entry.dropAfter));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    root, paths: dataPaths(path.join(root, 'data')), base, requests,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); fs.rmSync(root, { recursive: true, force: true }); }),
    serve: (name, buf, opts = {}) => { served.set(name, { buf, drops: 0, ...opts }); },
    runtime: (packs) => ({
      id: 'hrt-test', platform: `${process.platform}-${process.arch}`, hermes: { ref: 'v0', commit: 'c' },
      packs: packs.map((p): PackEntry => ({
        name: p.name, file: `${p.name}.tar.gz`, bytes: p.buf.length,
        sha256: p.tamper ? 'f'.repeat(64) : sha256(p.buf), required: p.required ?? p.name === 'core', url: `${base}/${p.name}.tar.gz`,
      })),
    }),
  };
}

test('downloads, verifies, extracts packs and activates the runtime', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}', 'bin/hermes': 'x' });
    const browser = await makeTarGz(f.root, 'browser', { 'tools/chromium/chrome': 'y' });
    f.serve('core.tar.gz', core); f.serve('browser.tar.gz', browser);
    const runtime = f.runtime([{ name: 'core', buf: core }, { name: 'browser', buf: browser }]);
    const phases = new Set<string>();
    const active = await installRuntime({
      runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false, onProgress: (p) => phases.add(p.phase),
    });
    assert.equal(active.id, 'hrt-test');
    assert.deepEqual(active.packs, ['core', 'browser']);
    assert.equal(fs.readFileSync(path.join(active.dir, 'bin', 'hermes'), 'utf8'), 'x');
    assert.equal(fs.readFileSync(path.join(active.dir, 'tools', 'chromium', 'chrome'), 'utf8'), 'y');
    assert.deepEqual(readActive(f.paths)?.packs, ['core', 'browser']);
    assert.ok(['download', 'verify', 'extract', 'activate'].every((p) => phases.has(p)));
    assert.equal(fs.readdirSync(f.paths.cache).length, 0, 'downloaded archives are removed after a successful install');
    assert.ok(!fs.existsSync(path.join(f.paths.runtime, 'hrt-test.staging')));
  } finally { await f.close(); }
});

test('resumes an interrupted download with a Range request', async () => {
  const f = await fixture();
  try {
    const big = Buffer.alloc(300000, 7);
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}', 'blob.bin': big.toString('latin1') });
    f.serve('core.tar.gz', core, { dropAfter: Math.floor(core.length / 2) });
    const runtime = f.runtime([{ name: 'core', buf: core }]);
    const active = await installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false, retryDelayMs: 10 });
    assert.equal(fs.statSync(path.join(active.dir, 'blob.bin')).size, big.length);
    assert.ok(f.requests.some((r) => r.range && /bytes=\d+-/.test(r.range)), 'the retry must ask for the remaining bytes only');
  } finally { await f.close(); }
});

test('restarts cleanly when the server ignores the Range header', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}', 'data.txt': 'z'.repeat(50000) });
    f.serve('core.tar.gz', core, { dropAfter: 1000, ignoreRange: true });
    const runtime = f.runtime([{ name: 'core', buf: core }]);
    const active = await installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false, retryDelayMs: 10 });
    assert.equal(fs.readFileSync(path.join(active.dir, 'data.txt'), 'utf8').length, 50000);
  } finally { await f.close(); }
});

test('a hash mismatch deletes the download and installs nothing', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}' });
    f.serve('core.tar.gz', core);
    const runtime = f.runtime([{ name: 'core', buf: core, tamper: true }]);
    await assert.rejects(installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false }), IntegrityError);
    assert.equal(readActive(f.paths), null);
    assert.equal(fs.readdirSync(f.paths.cache).length, 0);
    assert.deepEqual(fs.readdirSync(f.paths.runtime), []);
  } finally { await f.close(); }
});

test('the default policy refuses non-GitHub hosts and plain http', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}' });
    f.serve('core.tar.gz', core);
    const runtime = f.runtime([{ name: 'core', buf: core }]);
    await assert.rejects(installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: STRICT_POLICY, validate: false }), DownloadError);
    assert.equal(f.requests.length, 0, 'nothing may be requested from an untrusted host');
    assert.equal(STRICT_POLICY.isAllowed(new URL('https://github.com/x/y')), true);
    assert.equal(STRICT_POLICY.isAllowed(new URL('https://objects.githubusercontent.com/x')), true);
    assert.equal(STRICT_POLICY.isAllowed(new URL('http://github.com/x')), false);
    assert.equal(STRICT_POLICY.isAllowed(new URL('https://githubusercontent.com.evil.example/x')), false);
  } finally { await f.close(); }
});

test('a 404 fails fast instead of retrying', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}' });
    const runtime = f.runtime([{ name: 'core', buf: core }]);
    await assert.rejects(installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false, retryDelayMs: 5 }), DownloadError);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test('a second install of the same runtime is a no-op, and missing packs are added in place', async () => {
  const f = await fixture();
  try {
    const core = await makeTarGz(f.root, 'core', { 'runtime.json': '{}' });
    const media = await makeTarGz(f.root, 'media', { 'tools/ffmpeg/ffmpeg': 'f' });
    f.serve('core.tar.gz', core); f.serve('media.tar.gz', media);
    const runtime = f.runtime([{ name: 'core', buf: core }, { name: 'media', buf: media }]);
    const first = await installRuntime({ runtime, packs: [runtime.packs[0]], paths: f.paths, policy: OPEN_POLICY, validate: false });
    const before = f.requests.length;
    const again = await installRuntime({ runtime, packs: [runtime.packs[0]], paths: f.paths, policy: OPEN_POLICY, validate: false });
    assert.equal(again.dir, first.dir);
    assert.equal(f.requests.length, before, 'no download when everything is present');
    const both = await installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false });
    assert.equal(both.dir, first.dir, 'extra packs go into the existing runtime');
    assert.deepEqual(both.packs.sort(), ['core', 'media']);
    assert.equal(fs.readFileSync(path.join(both.dir, 'tools', 'ffmpeg', 'ffmpeg'), 'utf8'), 'f');
  } finally { await f.close(); }
});

test('a new runtime id replaces the old one after activation and cleans up', async () => {
  const f = await fixture();
  try {
    const v1 = await makeTarGz(f.root, 'core', { 'runtime.json': '{"v":1}' });
    f.serve('core.tar.gz', v1);
    const r1 = f.runtime([{ name: 'core', buf: v1 }]);
    const a1 = await installRuntime({ runtime: r1, packs: r1.packs, paths: f.paths, policy: OPEN_POLICY, validate: false });
    const v2 = await makeTarGz(f.root, 'core2', { 'runtime.json': '{"v":2}' });
    f.serve('core.tar.gz', v2);
    const r2 = { ...f.runtime([{ name: 'core', buf: v2 }]), id: 'hrt-next' };
    const a2 = await installRuntime({ runtime: r2, packs: r2.packs, paths: f.paths, policy: OPEN_POLICY, validate: false });
    assert.equal(a2.id, 'hrt-next');
    assert.equal(readActive(f.paths)?.id, 'hrt-next');
    assert.ok(fs.existsSync(a1.dir), 'the previous runtime is kept until the next install');
  } finally { await f.close(); }
});

test('two installs cannot run at once, and a dead owner does not block forever', async () => {
  const f = await fixture();
  try {
    const release = acquireInstallLock(f.paths);
    assert.throws(() => acquireInstallLock(f.paths), InstallLockedError);
    release();
    const release2 = acquireInstallLock(f.paths);
    release2();
    // A lock left by a process that no longer exists is taken over.
    fs.mkdirSync(path.join(f.paths.state, 'runtime.lock'), { recursive: true });
    fs.writeFileSync(path.join(f.paths.state, 'runtime.lock', 'owner.json'), JSON.stringify({ pid: 2147483646, at: Date.now() }));
    const release3 = acquireInstallLock(f.paths);
    release3();
  } finally { await f.close(); }
});

test('extraction cannot write outside the runtime folder', async () => {
  const f = await fixture();
  try {
    const src = fs.mkdtempSync(path.join(f.root, 'evil-'));
    fs.writeFileSync(path.join(src, 'runtime.json'), '{}');
    const out = path.join(f.root, 'evil.tar.gz');
    await tar.c({ gzip: true, file: out, cwd: src, preservePaths: true }, ['runtime.json', path.join('..', 'escaped.txt')].filter((p) => fs.existsSync(path.join(src, p)) || p === 'runtime.json'));
    const buf = fs.readFileSync(out);
    f.serve('core.tar.gz', buf);
    const runtime = f.runtime([{ name: 'core', buf }]);
    await installRuntime({ runtime, packs: runtime.packs, paths: f.paths, policy: OPEN_POLICY, validate: false });
    assert.ok(!fs.existsSync(path.join(f.paths.runtime, 'escaped.txt')));
    assert.ok(!fs.existsSync(path.join(f.paths.root, 'escaped.txt')));
  } finally { await f.close(); }
});
