import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const manifestPath = resolve(__dirname, '../../package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  contributes?: { configuration?: { properties?: Record<string, { default?: unknown; type?: string }> } };
};
const props = manifest.contributes?.configuration?.properties ?? {};

test('the extension defaults to keeping Hermes working without a confirmation per action', () => {
  // Deliberate product default (docs/agentic-reliability-debug.md): favor an agent that does not
  // stall waiting on the user, over asking before every edit and tool call. Both settings stay
  // user-changeable; this only guards against the default silently drifting back to "ask".
  assert.equal(props['hermesRangelTech.editApprovalMode']?.default, 'dont_ask');
  assert.equal(props['hermesRangelTech.autoApprovePermissions']?.default, true);
  assert.equal(props['hermesRangelTech.autoApprovePermissions']?.type, 'boolean');
});
