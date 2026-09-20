/**
 * The association rules used by VS Code file icon themes. Keeping this small
 * matcher independent of the extension host makes the precedence testable.
 */
export type FileIconThemeVariant = 'default' | 'light' | 'highContrast';

export interface FileIconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontColor?: string;
  fontSize?: string;
  fontId?: string;
}

export interface FileIconFontSource {
  path?: string;
  format?: string;
}

export interface FileIconFont {
  id?: string;
  src?: FileIconFontSource[];
  weight?: string;
  style?: string;
  size?: string;
}

export interface FileIconAssociations {
  file?: string;
  fileExtensions?: Record<string, string>;
  fileNames?: Record<string, string>;
  languageIds?: Record<string, string>;
}

export interface FileIconThemeDocument extends FileIconAssociations {
  iconDefinitions?: Record<string, FileIconDefinition>;
  fonts?: FileIconFont[];
  light?: FileIconAssociations;
  highContrast?: FileIconAssociations;
}

export interface FileIconPathParts {
  fileName: string;
  parentName?: string;
  extensionCandidates: string[];
}

export function fileIconPathParts(resourcePath: string): FileIconPathParts {
  const segments = resourcePath.replaceAll('\\', '/').split('/').filter(Boolean);
  const fileName = (segments.at(-1) ?? '').toLowerCase();
  const parentName = segments.length > 1 ? segments.at(-2)?.toLowerCase() : undefined;
  const extensionCandidates: string[] = [];
  let dot = fileName.indexOf('.', 1);
  while (dot >= 0 && dot < fileName.length - 1) {
    extensionCandidates.push(fileName.slice(dot + 1));
    dot = fileName.indexOf('.', dot + 1);
  }
  return { fileName, parentName, extensionCandidates };
}

function mergedAssociations(theme: FileIconThemeDocument, variant: FileIconThemeVariant): FileIconAssociations {
  const override = variant === 'light' ? theme.light : variant === 'highContrast' ? theme.highContrast : undefined;
  return {
    ...theme,
    ...override,
    fileExtensions: { ...theme.fileExtensions, ...override?.fileExtensions },
    fileNames: { ...theme.fileNames, ...override?.fileNames },
    languageIds: { ...theme.languageIds, ...override?.languageIds }
  };
}

function lookupAssociation(associations: Record<string, string> | undefined, value: string, parentName?: string): string | undefined {
  if (!associations || !value) return undefined;
  const values = new Map(Object.entries(associations).map(([key, iconId]) => [key.toLowerCase(), iconId]));
  if (parentName) {
    const parentMatch = values.get(`${parentName}/${value}`);
    if (parentMatch) return parentMatch;
  }
  return values.get(value);
}

/**
 * Mirrors VS Code's documented association order:
 * parent-qualified filename > filename > parent-qualified extension >
 * extension > language > default file icon.
 */
export function resolveFileIconId(
  theme: FileIconThemeDocument,
  resourcePath: string,
  variant: FileIconThemeVariant = 'default',
  languageId?: string
): string | undefined {
  const associations = mergedAssociations(theme, variant);
  const { fileName, parentName, extensionCandidates } = fileIconPathParts(resourcePath);
  const fileNameMatch = lookupAssociation(associations.fileNames, fileName, parentName);
  if (fileNameMatch) return fileNameMatch;

  for (const extension of extensionCandidates) {
    const extensionMatch = lookupAssociation(associations.fileExtensions, extension, parentName);
    if (extensionMatch) return extensionMatch;
  }

  const languageMatch = languageId ? lookupAssociation(associations.languageIds, languageId.toLowerCase()) : undefined;
  return languageMatch ?? associations.file;
}
