export const PI_ISOLATION_ARGS = Object.freeze(["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]);
export const PI_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls", "write", "edit", "bash"]);
export function isPiPermissionMode(mode: string): boolean { return ["pi-read-only", "pi-ask", "pi-native"].includes(mode); }
