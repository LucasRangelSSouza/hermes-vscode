// Loads the built extension into a real, isolated VS Code and checks it activates and registers its commands.
//   npm run build && node scripts/vscode-smoke/run.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

// Running from inside VS Code (or a terminal it started) sets this, and it turns the test instance into plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-vscode-user-'));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hrt-vscode-ws-'));
fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
// An existing-mode path that does not exist keeps the extension from opening any modal dialog.
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'hermesRangelTech.runtime.mode': 'existing',
  'hermesRangelTech.runtime.existingPath': path.join(os.tmpdir(), 'no-such-hermes-binary'),
  'security.workspace.trust.enabled': false,
  'workbench.startupEditor': 'none',
  'update.mode': 'none',
  'telemetry.telemetryLevel': 'off',
}));

try {
  await runTests({
    version: process.env.VSCODE_VERSION ?? 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, 'suite.cjs'),
    launchArgs: [workspace, '--user-data-dir', userData, '--disable-extensions', '--disable-gpu'],
  });
  console.log('VS Code smoke test passed');
} catch (err) {
  console.error('VS Code smoke test failed:', err);
  process.exitCode = 1;
} finally {
  fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
