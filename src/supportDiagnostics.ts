import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

/** Copy only a bounded numeric version; never include raw process output or errors. */
function numericVersion(value: unknown): string {
  if (typeof value !== 'string') return 'Unavailable';
  return value.match(/^([0-9]{1,5}\.[0-9]{1,5}(?:\.[0-9]{1,5})?)(?![0-9])/u)?.[1] ?? 'Unavailable';
}

export function diagnosticSummary(input: {
  extensionVersion: unknown; vscodeVersion: unknown; gitVersion: unknown;
  platform: unknown; architecture: unknown;
}): string {
  const platform = ['win32', 'darwin', 'linux'].includes(String(input.platform)) ? String(input.platform) : 'Other';
  const architecture = ['x64', 'arm64', 'ia32', 'arm'].includes(String(input.architecture)) ? String(input.architecture) : 'Other';
  return [
    'Kivo Git diagnostic summary',
    `Kivo Git: ${numericVersion(input.extensionVersion)}`,
    `VS Code: ${numericVersion(input.vscodeVersion)}`,
    `Git: ${numericVersion(input.gitVersion)}`,
    `Extension host platform: ${platform}`,
    `Extension host architecture: ${architecture}`
  ].join('\n');
}

async function readGitVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['--version'], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 4096, windowsHide: true
    });
    return /^git version ([0-9]{1,5}\.[0-9]{1,5}(?:\.[0-9]{1,5})?)/u.exec(stdout)?.[1];
  } catch {
    return undefined;
  }
}

export async function showSupportDiagnostics(
  context: vscode.ExtensionContext,
  queryGitVersion: () => Promise<string | undefined> = readGitVersion
): Promise<void> {
  const gitVersion = await queryGitVersion().catch(() => undefined);
  const summary = diagnosticSummary({
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    gitVersion,
    platform: process.platform,
    architecture: process.arch
  });
  const choice = await vscode.window.showInformationMessage(
    'Review diagnostic summary',
    { modal: true, detail: `${summary}\n\nNo repository contents, paths, remotes or logs are included. Nothing is uploaded.` },
    'Copy summary'
  );
  if (choice === 'Copy summary') {
    await vscode.env.clipboard.writeText(summary);
    void vscode.window.showInformationMessage('Diagnostic summary copied.');
  }
}
