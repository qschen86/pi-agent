import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { posix } from "node:path";
import type { ProjectedEvent } from "./types.js";

export interface SessionImageEntry {
  id: string;
  key: string;
  seq: number;
  kind: "generated" | "attachment" | "file";
  name: string;
  path?: string;
  /** 省略了目录的相对路径：同一条消息里另外写过的目录（最近的在前），读取时先按这些目录拼 */
  hints?: string[];
  attachmentId?: string;
}
const BITMAP = /\.(png|jpe?g|gif|webp)$/i;
/** Only metadata from this session's transcript. Actual reads retain their existing authorization. */
export function sessionImageIndex(events: readonly ProjectedEvent[]) {
  const items: SessionImageEntry[] = [];
  for (const e of events) {
    const seen = new Set<string>();
    const add = (kind: SessionImageEntry["kind"], resource: string, name: string, hints?: string[]) => {
      const identity = kind === "attachment" ? `attachment:${resource}` : `file:${resource}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      items.push({ id: createHash("sha256").update(`${e.key}\0${identity}`).digest("hex").slice(0, 24), key: e.key, seq: e.seq,
        kind, name, ...(kind === "attachment" ? { attachmentId: resource } : { path: resource }), ...(hints?.length ? { hints } : {}) });
    };
    for (const a of e.attachments || []) add("attachment", a.attachmentId, a.originalName || "图片附件");
    if (e.image?.path && (e.kind !== "image" || e.image.status === "completed")) {
      const path = imagePath(e.image.path);
      if (path) add(e.kind === "image" ? "generated" : "file", path, posix.basename(path));
    }
    for (const text of [e.text, e.tool?.input, e.tool?.output]) {
      if (!text) continue;
      const hints = directoryHints(text);
      // 正文里行内代码只写了图片文件名也算引用（工具输入输出里的裸文件名不算）
      for (const path of imageReferences(text, text === e.text)) add("file", path, posix.basename(path), /^(?:\/|~\/|file:\/\/)/.test(path) ? undefined : hints);
    }
  }
  return { firstSeq: events[0]?.seq, lastSeq: events.at(-1)?.seq, items };
}
/** Match file-chip path cues, while still finding real paths inside quoted shell commands. */
function imageReferences(text: string, bare = false) {
  const paths: Array<{ path: string; index: number }> = [];
  const occupied = [...text.matchAll(/\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi)].map(m => [m.index!, m.index! + m[0].length]);
  const covered = (index: number) => occupied.some(([start, end]) => index >= start! && index < end!);
  const add = (raw: string, index: number, length: number, decode = false) => {
    if (covered(index)) return;
    const path = imagePath(raw, decode);
    if (!path) return;
    paths.push({ path, index }); occupied.push([index, index + length]);
  };
  for (const m of text.matchAll(/\bfile:\/\/[^\s<>"'`()，。；！？;,]+/gi)) {
    add(m[0], m.index!, m[0].length);
    occupied.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    add(m[1]!, m.index!, m[0].length, true);
    // Never reinterpret pieces of an invalid/remote Markdown destination as local paths.
    occupied.push([m.index!, m.index! + m[0].length]);
  }
  if (bare) for (const m of text.matchAll(/`([\w一-龥.-]+\.(?:png|jpe?g|gif|webp))`/gi)) add(m[1]!, m.index!, m[0].length);
  for (const m of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) {
    // A suffix literal or an entire command is not a file reference. Relative basenames remain valid in explicit Markdown links.
    if (/^(?:\/|~\/|file:\/\/|\.\.?\/)|^[\w一-龥.-]+\//.test(m[1]!.trim())) add(m[1]!, m.index!, m[0].length);
  }
  const plain = /(?<![\w:/.])(?:file:\/\/\/|~\/|\/|\.\.?\/|[\w一-龥.-]+\/)[^\s<>"'`|()\[\]，。；！？;,]*?\.(?:png|jpe?g|gif|webp)(?::\d+(?::\d+)?)?(?=$|[\s，。,;；:：!?！？)\]}"'`]|\.(?=\s|$))/gi;
  for (const m of text.matchAll(plain)) add(m[0], m.index!, m[0].length);
  return paths.sort((a, b) => a.index - b.index).map(item => item.path);
}

function imagePath(raw: string, decode = false) {
  let path = raw.trim().replace(/^<|>$/g, "");
  try {
    if (path.startsWith("file://")) path = fileURLToPath(path);
    else if (decode) path = decodeURIComponent(path);
  } catch { return null; }
  path = path.replace(/:\d+(?::\d+)?$/, "");
  if (!path || path.length > 4096 || /[\0\r\n<>|]|;\s|\s&&\s|[?&][\w-]+=/.test(path) || /^[a-z][a-z0-9+.-]*:/i.test(path) || !BITMAP.test(path)) return null;
  return posix.normalize(path);
}

/** 消息里另外写过的目录：行内代码或 Markdown 链接里带「/」的片段，结尾是「/」就是目录本身，否则取文件所在目录；最近的在前，最多 8 个 */
export function directoryHints(text: string) {
  const found: Array<{ dir: string; index: number }> = [];
  const take = (raw: string, index: number, decode = false) => {
    let token = raw.trim().replace(/^<|>$/g, "");
    try { if (token.startsWith("file://")) token = fileURLToPath(token); else if (decode) token = decodeURIComponent(token); } catch { return; }
    token = token.replace(/:\d+(?::\d+)?$/, "");
    if (!token.includes("/") || token.length > 1024 || /[\s*<>|?]|^[a-z][a-z0-9+.-]*:/i.test(token) || token.startsWith("..")) return;
    const dir = token.endsWith("/") ? token : /\.[A-Za-z0-9]{1,12}$/.test(token) ? posix.dirname(token) : "";
    const clean = posix.normalize(dir).replace(/^\.\//, "").replace(/\/$/, "");
    if (clean && clean !== "." && clean !== "/" && !clean.startsWith("..")) found.push({ dir: clean, index });
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) take(m[1]!, m.index!);
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) take(m[1]!, m.index!, true);
  return [...new Set(found.sort((a, b) => b.index - a.index).map(item => item.dir))].slice(0, 8);
}
