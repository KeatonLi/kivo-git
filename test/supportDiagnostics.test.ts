import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

const ui = vi.hoisted(() => ({
  show: vi.fn(),
  copy: vi.fn()
}));
vi.mock('vscode', () => ({
  version: '1.105.2',
  window: { showInformationMessage: ui.show },
  env: { clipboard: { writeText: ui.copy } }
}));

import { diagnosticSummary, showSupportDiagnostics } from '../src/supportDiagnostics';

const context = { extension: { packageJSON: { version: '0.5.9' } } } as vscode.ExtensionContext;

beforeEach(() => {
  ui.show.mockReset();
  ui.copy.mockReset().mockResolvedValue(undefined);
});

describe('opt-in support diagnostics', () => {
  it('uses only bounded version components and recognized platform labels', () => {
    const result = diagnosticSummary({
      extensionVersion: '0.5.9\n/home/user/private',
      vscodeVersion: '1.105.2 https://secret@example.com',
      gitVersion: 'not a version /repo/secret',
      platform: '/private/platform', architecture: 'x64\nsecret'
    });
    expect(result).toBe([
      'Kivo Git diagnostic summary', 'Kivo Git: 0.5.9', 'VS Code: 1.105.2',
      'Git: Unavailable', 'Extension host platform: Other', 'Extension host architecture: Other'
    ].join('\n'));
    expect(result).not.toMatch(/private|secret|example|\/repo/);
  });

  it('previews the complete summary without copying when the user dismisses it', async () => {
    ui.show.mockResolvedValueOnce(undefined);
    await showSupportDiagnostics(context, async () => '2.48.1');
    expect(ui.copy).not.toHaveBeenCalled();
    expect(ui.show).toHaveBeenCalledOnce();
    const [title, options, action] = ui.show.mock.calls[0]!;
    expect(title).toBe('Review diagnostic summary');
    expect(options.modal).toBe(true);
    expect(options.detail).toContain('Git: 2.48.1');
    expect(options.detail).toContain('Nothing is uploaded.');
    expect(action).toBe('Copy summary');
  });

  it('copies exactly the previewed summary after the user chooses Copy', async () => {
    ui.show.mockResolvedValueOnce('Copy summary');
    await showSupportDiagnostics(context, async () => { throw new Error('/repo/secrets'); });
    const copied = ui.copy.mock.calls[0]?.[0];
    expect(copied).toContain('Git: Unavailable');
    expect(ui.show.mock.calls[0]?.[1].detail).toContain(copied);
    expect(copied).not.toContain('/repo/secrets');
    expect(ui.copy).toHaveBeenCalledOnce();
  });
});
