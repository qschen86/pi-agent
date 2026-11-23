import type { AppEntry } from './app-manifest.mjs';
export type DataLayout = 'flat' | 'apps';
export const LAYOUT_MARKER: string;
export const MIGRATION_JOURNAL: string;
export function layoutOf(dataDir: string): DataLayout;
export function resetLayoutCache(): void;
export function appRoot(dataDir: string, appId: string): string;
export function adoptAppsLayout(dataDir: string): boolean;
export interface MigrationMove { app: string; name: string; from: string; to: string }
export function planMigration(dataDir: string, apps?: AppEntry[]): { moves: MigrationMove[]; untouched: string[] };
export function applyMigration(dataDir: string, apps?: AppEntry[]): { moved: number; untouched: string[] };
export function rollbackMigration(dataDir: string): { restored: number };
export function ensureAppRoot(dataDir: string, appId: string): string;
