export const PI_ISOLATION_ARGS = Object.freeze(["--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates"]);
export const PI_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls", "write", "edit", "bash"]);
/** Pi 自带的 codemode（QuickJS 沙箱脚本）：--no-extensions 会连内置扩展一起关，所以要显式挂扩展并把工具名加进 --tools。评测装配不加，保持固定清单。 */
export const PI_CODEMODE_EXTENSION = "builtin:codemode";
export const PI_CODEMODE_TOOL = "codemode";
export function isPiPermissionMode(mode: string): boolean { return ["pi-read-only", "pi-ask", "pi-native"].includes(mode); }
/** bash 后台运行的配套工具（启动本身是带 background 的 bash 调用）。评测装配与只读会话不加。 */
export const PI_BACKGROUND_TOOL_NAMES = Object.freeze(["bash_output", "bash_kill"]);
