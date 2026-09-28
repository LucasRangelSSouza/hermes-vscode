// Pulls the per-platform manifests that .github/workflows/runtime-release.yml attached to a runtime
// release and merges them into runtime-manifest/manifest.json, the file embedded in the VSIX.
//
//   node scripts/sync-runtime-manifest.mjs <runtime-id> [owner/repo]
//
// Example: node scripts/sync-runtime-manifest.mjs hrt-20260928
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[2];
const repo = process.argv[3] ?? 'LucasRangelSSouza/hermes-vscode';
if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(id)) {
  console.error('Usage: node scripts/sync-runtime-manifest.mjs <runtime-id> [owner/repo]');
  process.exit(2);
}

const trusted = `https://github.com/${repo}/releases/download/runtime-${id}/`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-manifest-'));
try {
  execFileSync('gh', ['release', 'download', `runtime-${id}`, '-R', repo, '-p', 'manifest-*.json', '-D', tmp], { stdio: 'inherit' });
  const runtimes = {};
  for (const file of fs.readdirSync(tmp).sort()) {
    const doc = JSON.parse(fs.readFileSync(path.join(tmp, file), 'utf8'));
    if (doc.id !== id) throw new Error(`${file} belongs to runtime ${doc.id}, expected ${id}`);
    for (const p of doc.packs) {
      if (!p.url.startsWith(trusted)) throw new Error(`${file}: untrusted url ${p.url}`);
      if (!/^[0-9a-f]{64}$/.test(p.sha256)) throw new Error(`${file}: bad sha256 for ${p.name}`);
    }
    runtimes[doc.platform] = { id: doc.id, platform: doc.platform, hermes: doc.hermes, packs: doc.packs };
  }
  if (Object.keys(runtimes).length === 0) throw new Error('the release has no manifest-*.json assets');
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime-manifest', 'manifest.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ schema: 1, runtimes }, null, 2) + '\n');
  const gb = (n) => (n / 1024 ** 3).toFixed(2);
  for (const [key, r] of Object.entries(runtimes)) {
    const total = r.packs.reduce((s, p) => s + p.bytes, 0);
    console.log(`${key}: ${r.id}, Hermes ${r.hermes.ref} (${r.hermes.commit.slice(0, 9)}), ${r.packs.length} packs, ${gb(total)} GB`);
  }
  console.log(`wrote ${out}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
