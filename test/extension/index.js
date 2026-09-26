const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('keatonli.idea-git');
  assert.ok(extension, 'Kivo Git must be discoverable by the Extension Development Host.');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'ideaGit.focus',
    'ideaGit.showChanges',
    'ideaGit.showLog',
    'ideaGit.openResourceDiff',
    'ideaGit.showFileHistory',
    'ideaGit.moveResourceToChangelist',
    'ideaGit.showResourceInChanges',
    'ideaGit.changes.focus',
    'ideaGit.history.focus'
  ]) {
    assert.ok(commands.includes(command), `Expected command ${command} to be registered.`);
  }

  // These are the actual user entry points. A rejected promise here catches a
  // malformed contribution ID or a provider that did not activate correctly.
  await vscode.commands.executeCommand('ideaGit.showChanges');
  await vscode.commands.executeCommand('ideaGit.showLog');
  console.log('Kivo Git Extension Host smoke tests passed.');
};
