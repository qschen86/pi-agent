import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Only versioned, repository-owned skills can enter a compiled execution plan. */
export const SKILL_REFS = ["information-design@1", "information-design@2", "information-design@3"] as const;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../skills");

export interface PinnedSkill {
  ref: string;
  /** Frontmatter description: the only part that is always in the agent's context. */
  description: string;
  /** Full SKILL.md, pinned in the plan hash and handed out on demand (skill.load). */
  instructions: string;
}

/**
 * Only SKILL.md reaches the execution agent. The prompts/ files are stage prompts for the
 * host-side pipeline (runInformationDesign) and ask for JSON the agent cannot hand to a renderer.
 */
export function loadRegisteredSkill(ref: string): PinnedSkill {
  if (!SKILL_REFS.includes(ref as typeof SKILL_REFS[number])) throw new Error(`unknown skill ref: ${ref}`);
  const name = ref.slice(0, ref.lastIndexOf("@"));
  const version = Number(ref.slice(ref.lastIndexOf("@") + 1));
  // 第 1 版在 skills/<name>/SKILL.md（保持原位，已编译计划钉住的哈希不变）；之后的版本各占 skills/<name>/v<N>/
  const instructions = readFileSync(version === 1 ? join(ROOT, name, "SKILL.md") : join(ROOT, name, `v${version}`, "SKILL.md"), "utf8");
  const description = /^---\n[\s\S]*?^description:\s*(.+)$[\s\S]*?^---$/m.exec(instructions)?.[1]?.trim();
  if (!description) throw new Error(`skill ${ref} has no frontmatter description`);
  return { ref, description, instructions };
}
