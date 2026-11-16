/** Read native CLI transcripts from an evaluator's private config root through the SDK parser. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
export function evaluationHistoryStore(root: string, nativeSessionId: string): SessionStore | undefined {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(nativeSessionId)) return undefined;
  const projects = join(root, nativeSessionId, "config", "projects");
  if (!existsSync(projects)) return undefined;
  return {
    append: async () => { throw new Error("Evaluation history reader cannot write native transcripts"); },
    load: async (key) => {
      if (key.sessionId !== nativeSessionId) return null;
      for (const dir of readdirSync(projects, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue; // never follow directory symlinks
        const file = join(projects, dir.name, `${nativeSessionId}.jsonl`);
        const entry = readdirSync(join(projects, dir.name), { withFileTypes: true }).find((f) => f.name === `${nativeSessionId}.jsonl` && f.isFile());
        if (!entry) continue;
        if (statSync(file).size > 96 * 1024 * 1024) throw new Error("Evaluation native transcript exceeds read budget");
        const lines = readFileSync(file, "utf8").split("\n");
        // A partial last line is not a durable native message.
        return lines.slice(0, -1).filter((line) => line.trim()).map((line) => JSON.parse(line));
      }
      return null;
    }
  };
}
