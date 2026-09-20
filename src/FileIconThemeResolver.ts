import * as vscode from 'vscode';
import path from 'node:path';
import {
  fileIconPathParts,
  resolveFileIconId,
  type FileIconDefinition,
  type FileIconFont,
  type FileIconThemeDocument,
  type FileIconThemeVariant
} from './fileIconTheme';

export type WebviewFileIcon =
  | { kind: 'image'; uri: string }
  | { kind: 'font'; character: string; fontFamily: string; color?: string; fontSize?: string };

interface IconThemeContribution {
  id?: unknown;
  path?: unknown;
}

interface LanguageContribution {
  id?: unknown;
  extensions?: unknown;
  filenames?: unknown;
}

interface LoadedFont {
  id: string;
  family: string;
  definition: FileIconFont;
}

interface LoadedTheme {
  id: string;
  extensionUri: vscode.Uri;
  themeUri: vscode.Uri;
  document: FileIconThemeDocument;
  fonts: LoadedFont[];
}

const stringArray = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string')
  : [];
const objectArray = <T>(value: unknown): T[] => Array.isArray(value)
  ? value.filter((item): item is T => typeof item === 'object' && item !== null)
  : [];

const safeCssToken = (value: string | undefined, fallback: string): string => value && /^[a-zA-Z0-9 ._-]+$/.test(value) ? value : fallback;
const safeColor = (value: string | undefined): string | undefined => value && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
const safeRelativeSize = (value: string | undefined): string | undefined => value && /^\d+(?:\.\d+)?%$/.test(value) ? value : undefined;

function resourcePath(base: vscode.Uri, relativePath: string, extensionRoot: vscode.Uri, baseIsDirectory = true): vscode.Uri | undefined {
  const normalizedRelative = relativePath.replaceAll('\\', '/');
  if (!normalizedRelative || path.posix.isAbsolute(normalizedRelative)) return undefined;
  const targetBase = baseIsDirectory ? path.posix.dirname(base.path) : base.path;
  const targetPath = path.posix.normalize(path.posix.join(targetBase, normalizedRelative));
  const root = extensionRoot.path.endsWith('/') ? extensionRoot.path : `${extensionRoot.path}/`;
  if (targetPath !== extensionRoot.path && !targetPath.startsWith(root)) return undefined;
  return base.with({ path: targetPath });
}

function activeVariant(): FileIconThemeVariant {
  const { kind } = vscode.window.activeColorTheme;
  if (kind === vscode.ColorThemeKind.Light) return 'light';
  if (kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight) return 'highContrast';
  return 'default';
}

/**
 * Resolves the user's active VS Code file icon theme into CSP-safe webview
 * resources. A broken or font-less third-party theme simply falls back to the
 * native codicon rendered by the webview.
 */
export class FileIconThemeResolver {
  private loaded?: LoadedTheme;

  get localResourceRoots(): readonly vscode.Uri[] {
    return this.loaded ? [this.loaded.extensionUri] : [];
  }

  async refresh(): Promise<void> {
    try {
      this.loaded = await this.loadActiveTheme();
    } catch {
      // File icons are visual enhancement only. A malformed external theme must
      // never make the Commit tool window unusable.
      this.loaded = undefined;
    }
  }

  fontCss(webview: vscode.Webview): string {
    const loaded = this.loaded;
    if (!loaded) return '';
    return loaded.fonts.map((font) => {
      const sources = (font.definition.src ?? []).flatMap((source) => {
        if (!source.path) return [];
        const uri = resourcePath(loaded.themeUri, source.path, loaded.extensionUri);
        if (!uri) return [];
        const format = source.format && /^[a-zA-Z0-9_-]+$/.test(source.format) ? ` format('${source.format}')` : '';
        return [`url('${webview.asWebviewUri(uri)}')${format}`];
      });
      if (!sources.length) return '';
      const weight = safeCssToken(font.definition.weight, 'normal');
      const style = safeCssToken(font.definition.style, 'normal');
      return `@font-face{font-family:'${font.family}';src:${sources.join(',')};font-weight:${weight};font-style:${style};font-display:block;}`;
    }).filter(Boolean).join('\n');
  }

  iconsFor(webview: vscode.Webview, resourcePaths: readonly string[]): Record<string, WebviewFileIcon> {
    const loaded = this.loaded;
    if (!loaded) return {};
    const icons: Record<string, WebviewFileIcon> = {};
    const variant = activeVariant();
    for (const filePath of new Set(resourcePaths)) {
      const languageId = this.languageIdForPath(filePath);
      const iconId = resolveFileIconId(loaded.document, filePath, variant, languageId);
      const definition = this.definitionFor(iconId, loaded);
      if (!definition) continue;
      const icon = this.webviewIcon(definition, webview, loaded);
      if (icon) icons[filePath] = icon;
    }
    return icons;
  }

  private async loadActiveTheme(): Promise<LoadedTheme | undefined> {
    const activeThemeId = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    if (!activeThemeId) return undefined;
    for (const extension of vscode.extensions.all) {
      const themes = objectArray<IconThemeContribution>(extension.packageJSON?.contributes?.iconThemes);
      const contribution = themes.find((candidate) => candidate?.id === activeThemeId && typeof candidate.path === 'string');
      if (!contribution || typeof contribution.path !== 'string') continue;
      const themeUri = resourcePath(extension.extensionUri, contribution.path, extension.extensionUri, false);
      if (!themeUri) return undefined;
      const bytes = await vscode.workspace.fs.readFile(themeUri);
      const document = JSON.parse(Buffer.from(bytes).toString('utf8')) as FileIconThemeDocument;
      const fonts = (document.fonts ?? []).flatMap((font, index) => {
        if (!font?.id) return [];
        return [{ id: font.id, family: `kivo-file-icon-${activeThemeId.replace(/[^a-z0-9_-]/gi, '-')}-${index}`, definition: font }];
      });
      return { id: activeThemeId, extensionUri: extension.extensionUri, themeUri, document, fonts };
    }
    return undefined;
  }

  private definitionFor(iconId: string | undefined, loaded: LoadedTheme): FileIconDefinition | undefined {
    if (!iconId) return undefined;
    const definition = loaded.document.iconDefinitions?.[iconId];
    if (!definition) return undefined;
    const defaultId = resolveFileIconId(loaded.document, '__kivo_file_without_match__', activeVariant());
    const inherited = defaultId ? loaded.document.iconDefinitions?.[defaultId] : undefined;
    return { ...inherited, ...definition };
  }

  private webviewIcon(definition: FileIconDefinition, webview: vscode.Webview, loaded: LoadedTheme): WebviewFileIcon | undefined {
    if (definition.iconPath) {
      const uri = resourcePath(loaded.themeUri, definition.iconPath, loaded.extensionUri);
      if (uri) return { kind: 'image', uri: webview.asWebviewUri(uri).toString() };
    }
    if (!definition.fontCharacter) return undefined;
    const font = definition.fontId
      ? loaded.fonts.find((candidate) => candidate.id === definition.fontId)
      : loaded.fonts[0];
    if (!font) return undefined;
    return {
      kind: 'font',
      character: definition.fontCharacter,
      fontFamily: font.family,
      color: safeColor(definition.fontColor),
      fontSize: safeRelativeSize(definition.fontSize ?? font.definition.size)
    };
  }

  private languageIdForPath(resourcePathValue: string): string | undefined {
    const { fileName, extensionCandidates } = fileIconPathParts(resourcePathValue);
    const languages = vscode.extensions.all.flatMap((extension) => objectArray<LanguageContribution>(extension.packageJSON?.contributes?.languages));
    for (const language of languages) {
      if (typeof language.id !== 'string') continue;
      if (stringArray(language.filenames).some((name) => name.toLowerCase() === fileName)) return language.id;
    }
    for (const extensionCandidate of extensionCandidates) {
      for (const language of languages) {
        if (typeof language.id !== 'string') continue;
        if (stringArray(language.extensions).some((extension) => extension.replace(/^\./, '').toLowerCase() === extensionCandidate)) return language.id;
      }
    }
    return undefined;
  }
}
