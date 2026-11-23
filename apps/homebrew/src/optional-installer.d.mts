export const OPTIONAL_RUNTIMES: readonly ['codex', 'claude-code', 'antigravity'];
export function componentPath(root: string, runtime: string): string;
export function componentBinary(root: string, runtime: string): string;
export function isComponentInstalled(root: string, runtime: string): boolean;
export function installOptionalRuntime(options: {
  root: string;
  runtime: string;
  manifestRoot: string;
  npmCli?: string;
  execute?: (...args: unknown[]) => Promise<unknown>;
}): Promise<{ installed: boolean; reused: boolean; version: string }>;
