export type AppTier = 'core' | 'optional' | 'private';
export type AppEdition = 'homebrew';
export type InstanceEdition = AppEdition | 'full';
export interface AppEntry {
  id: string; name: string; tier: AppTier;
  api: string[]; pages: string[]; views: string[]; routeModules: string[]; assets: string[]; sources: string[]; data: string[];
  switchable?: boolean; description?: string; artifacts?: string[]; requires?: string[]; softRequires?: string[]; dataReads?: string[]; debt?: string[];
}
export const TIERS: AppTier[];
export const DATA_CLASSES: Array<'default' | 'private'>;
export const APPS: AppEntry[];
export const EDITIONS: Record<AppEdition, { optional: string[]; holdback: Record<string, string>; hideViews: string[] }>;
export function appById(id: string, apps?: AppEntry[]): AppEntry | undefined;
export function shippedApps(edition: AppEdition, apps?: AppEntry[]): AppEntry[];
export function omittedApps(edition: AppEdition, apps?: AppEntry[]): AppEntry[];
export function omittedPathPattern(edition: AppEdition, apps?: AppEntry[]): RegExp;
export function omittedSourcePattern(edition: AppEdition, apps?: AppEntry[]): RegExp;
export function omittedAssetPattern(edition: AppEdition, apps?: AppEntry[]): RegExp;
export function omittedViews(edition: AppEdition, apps?: AppEntry[]): string[];
export function validateManifest(apps?: AppEntry[]): string[];
export function ownerOf(kind: 'api' | 'pages' | 'views' | 'routeModules' | 'assets' | 'sources' | 'data', value: string, apps?: AppEntry[]): AppEntry | undefined;
export const dataName: (entry: string) => string;
export const isDataDir: (entry: string) => boolean;
export function switchableApps(edition: InstanceEdition, apps?: AppEntry[]): AppEntry[];
export function withDependents(off: Iterable<string>, apps?: AppEntry[]): Set<string>;
export function isPathOfApps(path: string, appIds: Iterable<string>, apps?: AppEntry[]): boolean;
export function appOfArtifact(artifactId: string, apps?: AppEntry[]): AppEntry | undefined;
