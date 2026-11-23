/** Host-owned, opt-in Pi assembly. Never reads a workspace's package declarations. */
import { FACT_TOOLS } from './hermes-extension.js';
import { factPolicyState } from './facts/runtime.js';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalPath, isWithin } from "../../adapter-pi/src/runtime-guard-policy.js";
import { validateBrowserProfile } from './browser-profile.js';
import { HERMES_TOOLS, HERMES_VERSION, validateHermesProfile } from './hermes-profile.js';

export const PI_BROWSER_TOOLS = Object.freeze([
  "browser_close", "browser_resize", "browser_console_messages", "browser_handle_dialog",
  "browser_evaluate", "browser_file_upload", "browser_fill_form", "browser_press_key", "browser_type",
  "browser_navigate", "browser_navigate_back", "browser_network_requests", "browser_take_screenshot",
  "browser_snapshot", "browser_click", "browser_drag", "browser_hover", "browser_select_option",
  "browser_tabs", "browser_wait_for"
].map(name => `mcp__playwright__${name}`));

export const PI_TEST_TOOLS = ['test_list','test_run'].map(name=>`mcp__playwright_test__${name}`);

export interface PiCommunityProfile {
  version: 1;
  permissionPackage: string;
  browser?: { packageRoot: string; executable: string; profileRoot?: string };
  testing?: { packageRoot:string; browserRoot?:string };
  memory?: { packageRoot: string; storeRoot: string };
}
export interface PreparedPiCommunity {
  profile: PiCommunityProfile;
  permissionEntry: string;
  serviceEntry: string;
  readable: string[];
  tools: string[];
  fingerprint: string;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi community profile must contain objects");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Unknown Pi community profile field");
}
function installationHash(root: string): string {
  const hash = createHash("sha256"); let count = 0, bytes = 0;
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (++count > 8192) throw new Error("Pi community package inventory exceeds limit");
      const file = join(dir, name), stat = lstatSync(file);
      // Dependencies are locked separately; do not traverse package-local installs.
      if (name === "node_modules") continue;
      if (stat.isSymbolicLink()) throw new Error("Pi community package must not contain symlinked code");
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        bytes += stat.size; if (bytes > 32 * 1024 * 1024) throw new Error("Pi community package inventory exceeds limit");
        hash.update(file.slice(root.length)); hash.update(readFileSync(file));
      }
    }
  };
  visit(root); return hash.digest("hex");
}
export function loadPiCommunityProfile(file: string, workspace: string): PreparedPiCommunity {
  const cwd = canonicalPath(workspace);
  const outside = (value: unknown): string => {
    if (typeof value !== "string" || !isAbsolute(value) || !existsSync(value)) throw new Error("Pi community paths must be absolute and installed");
    const path = realpathSync(value);
    if (isWithin(path, cwd) || isWithin(cwd, path)) throw new Error("Pi community installation/config must be outside the workspace");
    return path;
  };
  const source = outside(file), raw = record(JSON.parse(readFileSync(source, "utf8")));
  keys(raw, ["version", "permissionPackage", "browser", "memory", "testing"]);
  if (raw.version !== 1) throw new Error("Unsupported Pi community profile version");
  const permissionPackage = outside(raw.permissionPackage);
  const verifyPackage = (root: string, name: string, version: string) => {
    const pkg = record(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
    if (pkg.name !== name || pkg.version !== version) throw new Error(`Pi community requires ${name}@${version}`);
  };
  verifyPackage(permissionPackage, "@gotgenes/pi-permission-system", "40.2.2");
  const moduleRoot = (root: string) => {
    const modules = join(root, "../..");
    if (basename(modules) !== "node_modules") throw new Error("Pi community packages must use a scoped node_modules installation");
    return outside(modules);
  };
  const permissionEntry = outside(join(permissionPackage, "src/index.ts")), serviceEntry = outside(join(permissionPackage, "src/service.ts"));
  const readable = [moduleRoot(permissionPackage)];
  const profile: PiCommunityProfile = { version: 1, permissionPackage };
  if (raw.browser !== undefined) {
    const browser = record(raw.browser); keys(browser, ["packageRoot", "executable", "profileRoot"]);
    const packageRoot = outside(browser.packageRoot), executable = outside(browser.executable);
    verifyPackage(packageRoot, "@playwright/mcp", "0.0.83");
    if (!lstatSync(executable).isFile()) throw new Error("Pi browser executable must be a file");
    outside(join(packageRoot, "cli.js"));
    profile.browser = { packageRoot, executable };
    if(browser.profileRoot!==undefined){
      if(typeof browser.profileRoot!=='string')throw new Error('Browser profile root must be a path');
      const profileRoot=validateBrowserProfile(browser.profileRoot,workspace);
      if([source,permissionPackage,packageRoot,moduleRoot(packageRoot),moduleRoot(permissionPackage)].some(p=>isWithin(profileRoot,p)||isWithin(p,profileRoot)))throw new Error('Browser profile must be separate from runtime code and configuration');
      profile.browser.profileRoot=profileRoot;
    }
    readable.push(moduleRoot(packageRoot));
    const appEnd = executable.indexOf(".app/");
    if (process.platform === "darwin" && appEnd < 0) throw new Error("Pi browser must be an installed Chromium application bundle");
    readable.push(appEnd >= 0 ? executable.slice(0, appEnd + 4) : dirname(executable));
  }
  if (raw.memory !== undefined) {
    const memory = record(raw.memory); keys(memory, ['packageRoot', 'storeRoot']);
    const packageRoot = outside(memory.packageRoot);
    verifyPackage(packageRoot, 'pi-hermes-memory', HERMES_VERSION);
    outside(join(packageRoot, 'src/index.ts'));
    if (typeof memory.storeRoot !== 'string') throw new Error('Memory storeRoot must be a path');
    const { root: storeRoot } = validateHermesProfile(memory.storeRoot, workspace);
    const modules = outside(join(packageRoot, '..'));
    if (basename(modules) !== 'node_modules') throw new Error('Hermes must be installed in node_modules');
    if ([source, ...readable, modules].some(p => isWithin(storeRoot, p) || isWithin(p, storeRoot))) throw new Error('Memory must be separate from runtime code and configuration');
    profile.memory = { packageRoot, storeRoot }; readable.push(modules);
  }
  if(raw.testing!==undefined){
    const testing=record(raw.testing);keys(testing,['packageRoot','browserRoot']);
    const packageRoot=outside(testing.packageRoot);verifyPackage(packageRoot,'@playwright/test','1.63.0');outside(join(packageRoot,'cli.js'));
    profile.testing={packageRoot};readable.push(moduleRoot(packageRoot));
    if(testing.browserRoot!==undefined){const browserRoot=outside(testing.browserRoot);if(!lstatSync(browserRoot).isDirectory())throw new Error('Test browser root must be a directory');profile.testing.browserRoot=browserRoot;readable.push(browserRoot);}
  }
  const locks = [...new Set(readable.map(p => join(p, "..", "package-lock.json")))].filter(existsSync).map(file => createHash("sha256").update(readFileSync(file)).digest("hex"));
  return { profile, permissionEntry, serviceEntry, readable, tools: [...(profile.browser ? PI_BROWSER_TOOLS : []), ...(profile.memory ? [...HERMES_TOOLS,...(factPolicyState(profile.memory.storeRoot)?.enabled?FACT_TOOLS:[])] : []), ...(profile.testing ? PI_TEST_TOOLS : [])],
    fingerprint: createHash("sha256").update(JSON.stringify({profile, locks, permission: installationHash(permissionPackage), browser: profile.browser ? installationHash(profile.browser.packageRoot) : undefined, ...(profile.testing ? {testing:installationHash(profile.testing.packageRoot)}:{}), ...(profile.memory ? { memory: installationHash(profile.memory.packageRoot), ...(factPolicyState(profile.memory.storeRoot)?.enabled?{factPolicy:factPolicyState(profile.memory.storeRoot)}:{}), memorySource: validateHermesProfile(profile.memory.storeRoot, workspace).sourceId } : {})})).digest("hex") };
}

/** Browser tools that only observe the page or manage tabs; no page state is driven by them. */
export const PI_BROWSER_PASSIVE_TOOLS = Object.freeze([
  "browser_snapshot", "browser_console_messages", "browser_network_requests", "browser_take_screenshot",
  "browser_tabs", "browser_wait_for", "browser_resize", "browser_close", "browser_hover"
].map(name => `mcp__playwright__${name}`));

export interface CommunityPermissionScope {
  /** Real user home: content the OS guard hides from the sandbox. */
  home?: string;
  /** Paths outside the workspace that the OS guard really lets the sandbox read / write. */
  readRoots?: string[];
  writeRoots?: string[];
  /** A persistent (logged-in) browser profile keeps page-driving tools behind a human decision. */
  persistentBrowser?: boolean;
  /** 本轮注册了联网检索工具：它们是只读工具，来源范围由 Broker 判定，不再逐次问人。 */
  webResearch?: boolean;
  platformBrowser?: boolean;
  /** 本轮注册了 bash 后台运行：bash_output / bash_kill 只碰本进程自己的任务，不另外执行命令。 */
  backgroundBash?: boolean;
}
/** Read-only system and toolchain locations that every sandboxed command touches. */
const SYSTEM_READ_ROOTS = Object.freeze(["/usr", "/bin", "/sbin", "/opt", "/etc", "/private/etc", "/Library", "/System", "/Applications"]);
const globSafe = (path: string) => isAbsolute(path) && !/[*?]/.test(path);
/** A directory and everything under it, as the community matcher spells it. */
const tree = (root: string) => [root, `${root}/*`];

export function communityPermissionConfig(tools: string[], scope: CommunityPermissionScope = {}) {
  // Principle: ask a human only where their answer can change the outcome. The mandatory OS guard
  // (Seatbelt) is the real boundary; a prompt for something it will refuse anyway is a dead end that
  // costs a round trip and then fails with EPERM, so those are refused immediately instead.
  // The community parser checks every command in a pipeline/compound command and resolves external
  // paths. Ordinary development runs inside the OS workspace boundary; destructive and host/remote
  // administration commands still require a human decision.
  const bash: Record<string, string> = { "*": "allow" };
  for (const command of [
    "rm", "rmdir", "unlink", "shred", "dd", "mkfs*", "diskutil", "find *-delete*",
    "sudo", "su", "doas", "chmod", "chown", "chgrp",
    "kill", "killall", "pkill", "launchctl", "shutdown", "reboot",
    "ssh", "scp", "sftp", "rsync",
    "git reset", "git clean", "git restore", "git checkout", "git switch",
    "git branch", "git push", "git rebase", "git stash", "git reflog expire",
    "git -?*", "npm *publish*", "pnpm *publish*", "yarn *publish*",
  ]) {
    bash[`${command} *`] = "ask";
    // Command rules match the executable spelling, including absolute paths.
    bash[`*/${command} *`] = "ask";
  }
  // Listing branches changes nothing. Exact spellings only: anything with other flags (-d/-D/-m/-c...)
  // keeps asking. Rules are last-match-wins, so these come after the broad ask above.
  for (const form of ["", " -a", " -r", " -v", " -vv", " -av", " -avv", " --list", " --show-current"]) bash[`git branch${form}`] = "allow";

  const home = scope.home && globSafe(scope.home) ? scope.home : undefined;
  const readable = (scope.readRoots ?? []).filter(globSafe), writable = (scope.writeRoots ?? []).filter(globSafe);
  // Outside the workspace the OS guard hides the home directory. Toolchain/system locations are plain
  // reading and never prompt; the home directory is refused outright; any other location (a scratch
  // directory, another volume) is rare and still gets a human decision. Last match wins.
  const externalRead: Record<string, string> = { "*": "ask", ...Object.fromEntries(SYSTEM_READ_ROOTS.flatMap(tree).map(p => [p, "allow"])), ...(home ? Object.fromEntries(tree(home).map(p => [p, "deny"])) : {}), ...Object.fromEntries(readable.flatMap(tree).map(p => [p, "allow"])) };
  // Writes outside the workspace only work in the runtime's own writable roots.
  const externalWrite: Record<string, string> = { "*": "deny", ...Object.fromEntries(writable.flatMap(tree).map(p => [p, "allow"])) };

  // The browser/test servers run in the same OS guard as bash, which already runs any project code.
  // Asking per call only trains the user to click through (and exact-input session grants never match
  // a new click target). Passive tools never ask; page-driving tools ask only for a persistent profile.
  const mcp: Record<string, string> = { "*": "deny" };
  for (const tool of tools.filter(tool => ![...HERMES_TOOLS,...FACT_TOOLS].includes(tool))) {
    mcp[tool] = PI_BROWSER_TOOLS.includes(tool) && !PI_BROWSER_PASSIVE_TOOLS.includes(tool) && scope.persistentBrowser ? "ask" : "allow";
  }
  return { permission: { "*": "deny", read: "allow", grep: "allow", find: "allow", ls: "allow",
    write: "allow", edit: "allow", bash, bash_escalated: "allow",
    // codemode 自己不产生副作用；脚本里嵌套的 write/edit/bash 仍逐个按上面的规则判定（危险命令照常审批）。
    codemode: "allow",
    ...(scope.platformBrowser ? {platform_browser:"allow"} : {}),
    ...(scope.backgroundBash ? { bash_output: "allow", bash_kill: "allow" } : {}),
    ...(scope.webResearch ? { web_search: "allow", web_open: "allow" } : {}),
    external_directory_read: externalRead, external_directory_write: externalWrite,
    ...Object.fromEntries(tools.filter(tool => [...HERMES_TOOLS,...FACT_TOOLS].includes(tool)).map(tool => [tool, 'allow'])), mcp },
    authorizerChain: [], yoloMode: false };
}
