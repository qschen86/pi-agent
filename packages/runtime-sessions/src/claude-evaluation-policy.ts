/** Policy identity only. Formal qualification still requires all trusted native probe receipts. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync,statSync} from "node:fs";
import {release} from "node:os";
import {join,relative} from "node:path";
import {fileURLToPath} from "node:url";

/** The only tools a protected Claude evaluator gets (no MCP, plugins, user/project settings or hooks). */
export const CLAUDE_EVALUATION_TOOLS = Object.freeze(["Read", "Grep", "Glob", "Write", "Edit", "Bash", "WebFetch", "WebSearch"]);
const channels = Object.freeze([...CLAUDE_EVALUATION_TOOLS.map(tool => `claude:builtin:${tool}`), "claude:child-process", "claude:host-tool-gate"]);
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const harnessModules = [
  "./claude-evaluation-policy.js", "./claude.js", "./claude-boundary.js", "./claude-evaluation-history.js", "./driver.js", "./manager.js",
  "./store.js", "./evaluation.js", "./permissions.js", "./codex-client.js",
  "../../adapter-pi/src/runtime-guard-policy.js", "../../adapter-pi/src/runtime-guard.js", "../../adapter-pi/src/os-sandbox.js", "../../adapter-pi/src/process-tree.js"
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
// The native binary is large; rehash only when its file identity changes.
let binaryMemo: {key: string; digest: string} | undefined;
function binaryDigest(file: string): string {
  const st = statSync(file), key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (binaryMemo?.key !== key) binaryMemo = {key, digest: hash(readFileSync(file))};
  return binaryMemo.digest;
}

export function claudeEvaluationPolicy(sdkRoot: string, nativeBinary: string): {version: string; channels: string[]} | undefined {
  if (!loadedHarnessHash || harnessHash() !== loadedHarnessHash) return;
  try {
    const root = realpathSync(sdkRoot), binary = realpathSync(nativeBinary);
    if (!lstatSync(binary).isFile()) return;
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (pkg.name !== "@anthropic-ai/claude-agent-sdk" || typeof pkg.version !== "string") return;
    const manifest: Array<[string, string]> = [];
    let entries = 0;
    for (const name of readdirSync(root).sort()) {
      const file = join(root, name), st = lstatSync(file);
      // Unknown linked programs may load code outside the audited installation.
      if (st.isSymbolicLink()) return;
      if (st.isFile() && /\.(?:[cm]?js|json|node|wasm)$/.test(name)) { if (++entries > 512) return; manifest.push([relative(root, file), hash(readFileSync(file))]); }
    }
    const descriptor = {harness: loadedHarnessHash, sdk: pkg.version, sdkManifest: manifest, nativeBinary: binaryDigest(binary),
      platform: process.platform, arch: process.arch, osRelease: release(), tools: CLAUDE_EVALUATION_TOOLS, channels,
      boundary: "seatbelt-process-tree/report-only/no-mcp-no-plugins-no-settings/keychain-read-only/network-unrestricted"};
    return {version: `claude-evaluation@1:sha256:${hash(JSON.stringify(descriptor))}`, channels: [...channels]};
  } catch { return; }
}
