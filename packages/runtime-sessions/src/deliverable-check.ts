/**
 * 交付物可达性检查：回复里写给用户的文件路径 / 链接，用户在手机上点下去必须打得开。
 *
 * 前端（file-chips.js / runtime-chat.js）会把这些内容渲染成可点的胶囊或链接；这里在回合结束时按同样的口径提取，
 * 文件交给 web 层注入的校验器（与点开时同一套「定位 + 授权」判断），本机地址直接判不可达（手机走公网入口必然打不开）。
 * 不通过只自动反馈给模型，不在时间线给用户加提示。
 *
 * 只检查「交付物类」文件（图片 / 网页 / 文档 / 音视频 / 压缩包等）：讨论里顺口提到的源码文件
 * （如还没创建的 src/new.ts）不查，否则每次聊代码都会误报。
 */
export const DELIVERABLE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "html", "htm", "pdf", "md", "mp4", "mov", "webm", "mp3", "wav", "m4a",
  "zip", "csv", "tsv", "xlsx", "xls", "docx", "doc", "pptx", "ppt", "mmd", "puml"
]);
export const MAX_DELIVERABLE_REFS = 30;

export interface DeliverableFileRef { path: string; hints: string[] }
export interface DeliverableRefs { files: DeliverableFileRef[]; localUrls: string[] }
export interface DeliverableProblem { ref: string; reason: string }

const LOCAL_HOST = /^(?:localhost|0\.0\.0\.0|\[::1?\]|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^.]+\.local)$/i;
const FILE_PREFIX = /^(?:\/|~\/|file:\/\/|\.\.?\/)|^[\w\-.一-龥]+\/[\w\-./一-龥]+/;

/** 去掉围栏代码块（``` ... ```）：前端不把代码块里的内容渲染成可点的东西 */
const stripFences = (text: string): string => text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[`~]*[ \t]*(?=\n|$)|$)/gm, "");

function extensionOf(path: string): string { const name = path.split("/").pop() ?? ""; const m = /\.([A-Za-z0-9]{1,12})$/.exec(name); return m ? m[1]!.toLowerCase() : ""; }

/** explicit = Markdown 链接地址：作者明确写成链接的，不要求带目录（与前端 fileReference 的 explicit 同口径） */
function cleanFilePath(raw: string, decode: boolean, explicit = false): string | undefined {
  let path = raw.trim().replace(/^<|>$/g, "");
  if (!path || path.startsWith("#") || path.endsWith("/")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^file:\/\//i.test(path)) return undefined;
  if (decode && !/^file:\/\//i.test(path)) { try { path = decodeURIComponent(path); } catch { /* 保持原文 */ } }
  path = path.replace(/#[^/]*$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!path || /[\0\r\n]/.test(path) || path.length > 1024) return undefined;
  if (!explicit && !FILE_PREFIX.test(path) && !/^[\w\-.一-龥]+\.(?:png|jpe?g|gif|webp)$/i.test(path)) return undefined;
  return DELIVERABLE_EXTENSIONS.has(extensionOf(path)) ? path : undefined;
}

/** 消息里另外写过的目录（行内代码或链接里带「/」的片段），省略目录的相对路径先按这些目录找；与前端 fileDirectoryHints 同口径 */
function directoryHints(text: string): string[] {
  const found: Array<{ dir: string; index: number }> = [];
  const take = (raw: string, index: number, decode: boolean): void => {
    let token = raw.trim().replace(/^<|>$/g, "");
    try { if (token.startsWith("file://")) token = decodeURIComponent(token.slice(7)); else if (decode) token = decodeURIComponent(token); } catch { return; }
    token = token.replace(/:\d+(?::\d+)?$/, "");
    if (!token.includes("/") || token.length > 1024 || /[\s*<>|?]|^[a-z][a-z0-9+.-]*:/i.test(token) || token.startsWith("..")) return;
    const dir = token.endsWith("/") ? token : /\.[A-Za-z0-9]{1,12}$/.test(token) ? token.slice(0, token.lastIndexOf("/")) || "/" : "";
    const clean = dir.replace(/^\.\//, "").replace(/\/+$/, "");
    if (clean && clean !== "." && !clean.startsWith("..")) found.push({ dir: clean, index });
  };
  for (const m of text.matchAll(/`([^`\n]+)`/g)) take(m[1]!, m.index!, false);
  for (const m of text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) take(m[1]!, m.index!, true);
  return [...new Set(found.sort((a, b) => b.index - a.index).map((x) => x.dir))].slice(0, 8);
}

export function extractDeliverableRefs(assistantText: string): DeliverableRefs {
  const text = stripFences(assistantText);
  const hints = directoryHints(text);
  const files = new Map<string, DeliverableFileRef>();
  const localUrls = new Set<string>();
  const addFile = (path: string | undefined): void => { if (path && files.size < MAX_DELIVERABLE_REFS && !files.has(path)) files.set(path, { path, hints: /^(?:\/|~\/|file:\/\/)/.test(path) ? [] : hints }); };
  const addUrl = (url: string): void => {
    try { if (LOCAL_HOST.test(new URL(url).hostname)) localUrls.add(url.replace(/[.,;:!?'"，。；：！？）)\]]+$/, "")); } catch { /* 不是合法地址：不查 */ }
  };

  // 1. Markdown 链接 / 图片：地址是文件路径就查文件，是 http(s) 就看是不是本机地址
  let rest = text.replace(/!?\[((?:\\.|[^\]\\\n])+)\]\((<[^>\n]+>|[^)\n]+)\)/g, (_all, _label: string, target: string) => {
    const t = target.trim().replace(/^<|>$/g, "");
    if (/^https?:\/\//i.test(t)) addUrl(t); else addFile(cleanFilePath(t, true, true));
    return " ";
  });
  // 2. 行内代码：文件路径当文件查；本机地址写在行内代码里是「给人读的说明」，前端不会做成链接，不查
  rest = rest.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_all, _ticks: string, code: string) => { addFile(cleanFilePath(code.trim(), false)); return " "; });
  // 3. 剩下的正文：裸链接、裸的绝对 / 相对路径
  for (const m of rest.matchAll(/\bhttps?:\/\/[^\s<>()\]]+/gi)) addUrl(m[0]);
  const withoutUrls = rest.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>]+/gi, " ");
  for (const m of withoutUrls.matchAll(/(?<![\w:/.])((?:file:\/\/|~\/|\/|\.\.?\/|[\w一-龥.-]+\/)[^\s<>`"'|()[\],，。；！？;]*?\.[a-zA-Z0-9]{1,12}(?::\d+(?::\d+)?)?)(?=$|[\s，。,;；:：!?！？)\]]|\.(?=\s|$))/g)) addFile(cleanFilePath(m[1]!, false));
  return { files: [...files.values()], localUrls: [...localUrls] };
}

/** 文件校验器：由 web 层注入，返回读不到的文件及原因（与用户点开时同一套判断） */
export type DeliverableFileChecker = (input: { pid: string; workspace: string; runtimeKind: string; refs: DeliverableFileRef[] }) => Promise<DeliverableProblem[]>;

export async function deliverableProblems(input: { pid: string; workspace: string; runtimeKind: string; assistantText: string; checkFiles: DeliverableFileChecker | undefined }): Promise<string[]> {
  const refs = extractDeliverableRefs(input.assistantText);
  const problems: string[] = [];
  for (const url of refs.localUrls) problems.push(`${url}：本机地址，用户在手机或公网入口点开必然打不开`);
  if (refs.files.length && input.checkFiles) {
    try { for (const p of await input.checkFiles({ pid: input.pid, workspace: input.workspace, runtimeKind: input.runtimeKind, refs: refs.files })) problems.push(`${p.ref}：${p.reason}`); } catch { /* 校验器自己出错：不当作交付物有问题 */ }
  }
  return problems;
}

/** 反馈给模型的「怎么改」。 */
export const DELIVERABLE_FIX = [
  "1. 给用户看的文件必须真实存在，并放在会话工作目录之内（或本会话明确引用过的 /tmp 临时文件）；先创建 / 复制好文件，再在回复里写路径，路径以工作目录为基准写相对路径。",
  "2. 不要把 `http://127.0.0.1:端口`、`localhost`、局域网 IP 这类本机地址当成给用户的链接：用户多半在手机上看，点不开。网页 / 原型请把 HTML 文件放进工作目录，只写它的文件路径，平台会提供文件预览。",
  "3. 如果某个本机地址只是给自己人看的说明（不需要用户去点），用行内代码（反引号）包起来即可，不会被当成链接。",
  "4. 没有交付文件给用户的，不要在回复里写不存在的路径。"
].join("\n");
