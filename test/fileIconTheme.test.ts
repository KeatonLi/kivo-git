import { describe, expect, it } from 'vitest';
import { resolveFileIconId, type FileIconThemeDocument } from '../src/fileIconTheme';

const theme: FileIconThemeDocument = {
  file: '_file',
  fileNames: {
    'package.json': '_package',
    'system/win.ini': '_system-win-ini'
  },
  fileExtensions: {
    'ts': '_typescript',
    'd.ts': '_typescript-definition',
    'ini': '_ini',
    'system/ini': '_system-ini'
  },
  languageIds: { markdown: '_markdown' },
  light: { fileExtensions: { ts: '_typescript-light' } }
};

describe('VS Code file icon association precedence', () => {
  it('prefers a file name over a matching extension', () => {
    expect(resolveFileIconId(theme, 'packages/kivo/package.json')).toBe('_package');
  });

  it('prefers parent-qualified file names and extensions', () => {
    expect(resolveFileIconId(theme, 'SYSTEM/win.ini')).toBe('_system-win-ini');
    expect(resolveFileIconId(theme, 'system/settings.ini')).toBe('_system-ini');
  });

  it('recognises the longest multi-dot extension before its suffix', () => {
    expect(resolveFileIconId(theme, 'src/graph.d.ts')).toBe('_typescript-definition');
  });

  it('falls back from extension to language to the generic file icon', () => {
    expect(resolveFileIconId(theme, 'README', 'default', 'markdown')).toBe('_markdown');
    expect(resolveFileIconId(theme, 'README')).toBe('_file');
  });

  it('uses light-theme association overrides without losing the base mapping', () => {
    expect(resolveFileIconId(theme, 'src/main.ts', 'light')).toBe('_typescript-light');
    expect(resolveFileIconId(theme, 'src/main.d.ts', 'light')).toBe('_typescript-definition');
  });
});
