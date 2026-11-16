export function scanViolation(name: string, input: unknown, options?: { cwd?: string; allow?: string; repoRoot?: string }): string | undefined;
export function scanViolations(name: string, input: unknown, options?: { cwd?: string; allow?: string; repoRoot?: string }): string[];
