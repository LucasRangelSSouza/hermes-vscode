// Runs inside VS Code's extension host.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const COMMANDS = [
  'openChat', 'newSession', 'setup', 'configureProvider', 'testConnection', 'installRuntime',
  'selectPortableRuntime', 'runtimeStatus', 'configureSkills', 'syncSkills', 'selectProfile', 'selectEditApprovalMode', 'restartAgent', 'showLogs',
].map((c) => `hermesRangelTech.${c}`);

exports.run = async function run() {
  const ext = vscode.extensions.getExtension('lucasrangel.hermes-by-rangel-tech');
  assert.ok(ext, 'the extension is not installed in the test instance');
  await ext.activate();
  assert.equal(ext.isActive, true, 'the extension did not activate');

  const registered = await vscode.commands.getCommands(true);
  for (const command of COMMANDS) {
    assert.ok(registered.includes(command), `command ${command} is not registered`);
  }

  const config = vscode.workspace.getConfiguration('hermesRangelTech');
  assert.equal(config.get('runtime.mode'), 'existing');
  assert.equal(config.inspect('editApprovalMode').defaultValue, 'dont_ask');
  assert.equal(config.inspect('autoApprovePermissions').defaultValue, true);
  assert.equal(config.inspect('runtime.optionalPacks').defaultValue.includes('browser'), true);

  // The view container and chat view exist and the view can be revealed without throwing.
  await vscode.commands.executeCommand('hermesRangelTech.chatView.focus');
  await vscode.commands.executeCommand('hermesRangelTech.showLogs');
  console.log('extension activated, %d commands registered', COMMANDS.length);
};
