const assert = require('node:assert/strict');
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async function run() {
  const extension = vscode.extensions.getExtension('KeatonLi.kivo-git');
  assert.ok(extension, 'Kivo Git must be discoverable by the Extension Development Host.');
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'ideaGit.focus',
    'ideaGit.showChanges',
    'ideaGit.showLog',
    'ideaGit.openResourceDiff',
    'ideaGit.showFileHistory',
    'ideaGit.showLineBlame',
    'ideaGit.revealBlameCommit',
    'ideaGit.toggleInlineBlame',
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
  const before = vscode.workspace.getConfiguration('ideaGit').get('inlineBlame.enabled');
  await vscode.commands.executeCommand('ideaGit.toggleInlineBlame');
  assert.equal(vscode.workspace.getConfiguration('ideaGit').get('inlineBlame.enabled'), !before);
  await vscode.commands.executeCommand('ideaGit.toggleInlineBlame');
  assert.equal(vscode.workspace.getConfiguration('ideaGit').get('inlineBlame.enabled'), before);
  // Exercise the same built-in Merge Editor entry point used by Kivo against
  // a real unmerged index, rather than only asserting command registration.
  const root = await fs.mkdtemp(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'merge-editor-'));
  const exec = promisify(execFile);
  const git = (...args) => exec('git', args, { cwd: root });
  try {
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'Kivo Test'); await git('config', 'user.email', 'kivo@example.test');
    const file = path.join(root, 'conflicted.txt');
    await fs.writeFile(file, 'base\n'); await git('add', '.'); await git('commit', '-m', 'initial');
    await git('switch', '-c', 'feature'); await fs.writeFile(file, 'feature\n'); await git('commit', '-am', 'feature');
    await git('switch', 'main'); await fs.writeFile(file, 'main\n'); await git('commit', '-am', 'main');
    await assert.rejects(git('merge', 'feature'));
    const builtinGit = vscode.extensions.getExtension('vscode.git');
    assert.ok(builtinGit, 'The built-in Git extension should be available.');
    await builtinGit.activate();
    const repository = await builtinGit.exports.getAPI(1).openRepository(vscode.Uri.file(root));
    assert.ok(repository, 'Git must recognize the conflicted repository.');
    await repository.status();
    await vscode.commands.executeCommand('git.openMergeEditor', vscode.Uri.file(file));
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputTextMerge && tab.input.result.fsPath === file)), 'The native Merge Editor should open for the conflicted file.');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log('Kivo Git Extension Host smoke tests passed.');
};
