/** Policy identity only. Formal qualification still requires all trusted native probe receipts. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from "node:fs";
import {release} from "node:os";
import {join,relative} from "node:path";
import {fileURLToPath} from "node:url";

import {PI_ISOLATION_ARGS, PI_TOOL_NAMES} from "../../pi-runtime/src/policy.js";
export {PI_ISOLATION_ARGS, PI_TOOL_NAMES};
const channels = Object.freeze([...PI_TOOL_NAMES.map(tool => `pi:builtin:${tool}`), "pi:child-process", "pi:host-approval-extension"]);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const harnessModules = [
  "./pi-evaluation-policy.js", "./pi.js", "./pi-boundary.js", "./pi-client.js", "./pi-history.js",
  "./pi-projection.js", "./pi-approval-extension.ts", "./driver.js", "./manager.js", "./store.js", "./evaluation.js", "./permissions.js",
  "./pi-command-executor.js", "./pi-worktree-access.js", "./pi-community-profile.js",
  "../../pi-runtime/src/pi-boundary.js", "../../pi-runtime/src/pi-community-profile.js", "../../pi-runtime/src/pi-command-executor.js",
  "../../pi-runtime/src/screenshot-policy.mjs", "../../pi-runtime/src/scan-policy.mjs", "../../pi-runtime/src/pi-approval-extension.ts", "../../pi-runtime/src/pi-worktree-access.js", "../../pi-runtime/src/policy.js",
  "../../pi-runtime/src/pi-client.js", "../../pi-runtime/src/supervisor.js", "../../pi-runtime/src/types.js", "../../pi-runtime/src/connection.js", "../../pi-runtime/src/registration.js", "../../pi-runtime/src/cli.js", "../../pi-runtime/bin/pi-runtime.mjs",
  "../../pi-runtime/src/assembly-history.js", "../../pi-runtime/src/playwright-test-mcp.mjs", "../../pi-runtime/src/playwright-test-preload.mjs",
  "../../pi-runtime/src/permission-control.js", "../../pi-runtime/src/permission-mutex.js",
  "../../pi-runtime/src/browser-catalog.js", "../../pi-runtime/src/browser-discovery.js",
  "../../pi-runtime/src/community-approval.js", "../../pi-runtime/src/browser-profile.js", "../../pi-runtime/src/browser-mcp-lifecycle.mjs",
  "../../adapter-pi/src/pi-runtime-env.js", "../../adapter-pi/src/runtime-guard-policy.js",
  "../../adapter-pi/src/runtime-guard.js", "../../adapter-pi/src/os-sandbox.js", "../../adapter-pi/src/process-tree.js"
];
function harnessHash(): string | undefined {
  try {
    return hash(JSON.stringify(harnessModules.map(module => {
      let file = fileURLToPath(new URL(module, import.meta.url));
      if (!existsSync(file) && file.endsWith(".js")) file = file.slice(0, -3) + ".ts";
      if (!lstatSync(file).isFile()) throw new Error("Unknown harness source");
      return [module, hash(readFileSync(file))];
    })));
  } catch { return; }
}
// The loaded adapter must match its files. A hot source edit needs a process restart.
const loadedHarnessHash = harnessHash();

export function piEvaluationPolicy(binaryPath: string, packageRoot: string): {version: string; channels: string[]} | undefined {
  if (!loadedHarnessHash || harnessHash() !== loadedHarnessHash) return;
  try {
    const root = realpathSync(packageRoot), binary = realpathSync(binaryPath), dist = join(root, "dist");
    const binaryRelative = relative(root, binary);
    if (!binaryRelative || binaryRelative.startsWith("..") || !lstatSync(binary).isFile() || lstatSync(dist).isSymbolicLink()) return;
    if (!lstatSync(join(root, "package.json")).isFile()) return;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.name !== "@earendil-works/pi-coding-agent" || typeof pkg.version !== "string") return;
    const args = readFileSync(join(dist, "cli", "args.js"), "utf8");
    if ([...PI_ISOLATION_ARGS, "--append-system-prompt", "--tools"].some(flag => !args.includes(`arg === "${flag}"`))) return;
    const manifest: Array<[string, string]> = [["package.json", hash(readFileSync(join(root, "package.json")))]];
    let totalBytes = 0, entries = 0;
    const visit = (directory: string) => {
      for (const name of readdirSync(directory).sort()) {
        if (++entries > 8192) throw new Error("Unbounded native program inventory");
        const file = join(directory, name), stat = lstatSync(file);
        // Unknown linked programs may load code outside the audited installation.
        if (stat.isSymbolicLink()) throw new Error("Unknown linked native program");
        if (stat.isDirectory()) visit(file);
        else if (stat.isFile() && /\.(?:[cm]?js|json|wasm|node)$/.test(name)) {
          totalBytes += stat.size;
          if (totalBytes > 256 * 1024 * 1024) throw new Error("Native program inventory too large");
          manifest.push([relative(root, file), hash(readFileSync(file))]);
        }
      }
    };
    visit(dist);
    if (!manifest.some(([file]) => file === binaryRelative)) manifest.push([binaryRelative, hash(readFileSync(binary))]);
    manifest.sort(([a], [b]) => a.localeCompare(b));
    const descriptor = {harness: loadedHarnessHash, native: manifest, binary: binaryRelative, platform: process.platform,
      arch: process.arch, osRelease: release(), isolationArgs: PI_ISOLATION_ARGS, tools: PI_TOOL_NAMES, channels,
      boundary: "seatbelt-process-tree/report-only/private-provider-state/network-unrestricted"};
    return {version: `pi-evaluation@1:sha256:${hash(JSON.stringify(descriptor))}`, channels: [...channels]};
  } catch { return; }
}
