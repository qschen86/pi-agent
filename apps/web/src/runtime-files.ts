/**
 * 运行时会话里提到的图片 / HTML 文件：只允许本会话工作目录之内的文件。
 *
 * 安全约定：
 *  - 相对路径按会话工作目录解析；解析真实路径（realpath）后必须仍在工作目录之内，挡住 `../` 与符号链接越界
 *  - 只认图片（png / jpg / gif / webp / svg）与 HTML，限制大小
 *  - SVG 与 HTML 原样返回时带沙箱 CSP：不执行脚本、不加载外部资源（与任务交付物的安全预览一致）
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export type SessionFileKind = "image" | "html";

const MEDIA: Record<string, { mediaType: string; kind: SessionFileKind }> = {
  ".png": { mediaType: "image/png", kind: "image" },
  ".jpg": { mediaType: "image/jpeg", kind: "image" },
  ".jpeg": { mediaType: "image/jpeg", kind: "image" },
  ".gif": { mediaType: "image/gif", kind: "image" },
  ".webp": { mediaType: "image/webp", kind: "image" },
  ".svg": { mediaType: "image/svg+xml", kind: "image" },
  ".html": { mediaType: "text/html; charset=utf-8", kind: "html" },
  ".htm": { mediaType: "text/html; charset=utf-8", kind: "html" }
};
export const SESSION_FILE_MAX = { image: 25 * 1024 * 1024, html: 5 * 1024 * 1024 } as const;

/**
 * HTML 交互预览（files/view）：可以执行脚本，但始终在沙箱里、不给同源权限——
 * 页面来源是匿名的，读不到控制台的 Cookie、调不了控制台接口；不能导航顶层页面。
 * 允许内联脚本与样式、https 上的 CDN 资源，以及同目录的相对资源（经同一个工作目录核对）。
 */
export const SESSION_HTML_INTERACTIVE_CSP = [
  "default-src 'none'", "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:", "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:", "font-src 'self' data: https:", "media-src 'self' data: blob: https:", "connect-src 'self' https:",
  "worker-src blob:", "frame-src 'none'", "form-action 'none'", "base-uri 'self'", "frame-ancestors 'self'",
  "sandbox allow-scripts allow-popups allow-forms allow-modals"
].join("; ");

/** 交互预览时页面可引用的同目录资源类型 */
const ASSET_MEDIA: Record<string, string> = {
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf"
};
const ASSET_MAX = 10 * 1024 * 1024;

/** SVG / HTML 原样返回时的 CSP：沙箱、无脚本、只允许内联样式与 data: 资源 */
export const SESSION_FILE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; sandbox";

export type SessionFile =
  | { ok: true; path: string; real: string; rel: string; kind: SessionFileKind; mediaType: string; size: number; mtime: string }
  | { ok: false; path: string; reason: string };

/** 去掉模型输出里常见的包裹：引号、反引号、file://、行尾标点 */
function clean(p: string): string {
  let s = String(p ?? "").trim();
  // 包裹与行尾标点可能交替出现（如 `a.png`，）：反复去掉直到不再变化
  for (let prev = ""; prev !== s;) { prev = s; s = s.replace(/^["'`<(（]+|["'`>)）]+$/g, "").replace(/[，。,;；:：!?！？]+$/, ""); }
  if (s.startsWith("file://")) { try { s = decodeURIComponent(s.slice("file://".length)); } catch { return ""; } }
  return s;
}

export function resolveSessionFile(workspace: string | undefined, input: string): SessionFile {
  return resolveIn(workspace, clean(input), false);
}

/** 交互预览里页面引用的资源：除图片与 HTML 外，还允许样式、脚本、数据与字体（同样只在工作目录之内） */
export function resolveSessionAsset(workspace: string | undefined, rel: string): SessionFile | { ok: true; path: string; real: string; rel: string; kind: "asset"; mediaType: string; size: number; mtime: string } {
  const ext = extname(rel).toLowerCase();
  if (MEDIA[ext]) return resolveIn(workspace, rel, true);
  const mediaType = ASSET_MEDIA[ext];
  if (!mediaType) return { ok: false, path: rel, reason: "不支持的资源类型" };
  const base = resolveIn(workspace, rel, true, { mediaType, kind: "image" }, ASSET_MAX);
  return base.ok ? { ...base, kind: "asset", mediaType } : base;
}

function resolveIn(workspace: string | undefined, path: string, asset: boolean, forced?: { mediaType: string; kind: SessionFileKind }, max?: number): SessionFile {
  if (!path) return { ok: false, path, reason: "路径为空" };
  if (!workspace || !isAbsolute(workspace)) return { ok: false, path, reason: "会话没有可用的工作目录" };
  if (path.startsWith("~") || path.includes("\0")) return { ok: false, path, reason: "不支持的路径写法" };
  if (asset && isAbsolute(path)) return { ok: false, path, reason: "资源路径必须相对工作目录" };
  const media = forced ?? MEDIA[extname(path).toLowerCase()];
  if (!media) return { ok: false, path, reason: "只支持预览图片与 HTML" };
  let root: string, real: string;
  try { root = realpathSync(workspace); } catch { return { ok: false, path, reason: "工作目录已不存在" }; }
  try { real = realpathSync(isAbsolute(path) ? path : resolve(workspace, path)); } catch { return { ok: false, path, reason: "文件不存在" }; }
  if (real !== root && !real.startsWith(root + sep)) return { ok: false, path, reason: "文件不在本会话的工作目录内" };
  let st;
  try { st = statSync(real); } catch { return { ok: false, path, reason: "文件不存在" }; }
  if (!st.isFile()) return { ok: false, path, reason: "不是文件" };
  const cap = max ?? SESSION_FILE_MAX[media.kind];
  if (st.size > cap) return { ok: false, path, reason: `文件太大（超过 ${Math.round(cap / 1024 / 1024)} MB）` };
  return { ok: true, path, real, rel: relative(root, real).split(sep).join("/"), kind: media.kind, mediaType: media.mediaType, size: st.size, mtime: st.mtime.toISOString() };
}

/**
 * 交互预览时把同目录的本地资源内联进 HTML：沙箱页面来源是匿名的，再去请求同目录文件时浏览器不带登录 Cookie
 * （对外域名上会被拦），而把访问令牌放进地址又可能被页面脚本外传。所以由服务端在返回前内联：
 *  - <script src="相对路径"> → 内联脚本；<link rel="stylesheet" href="相对路径"> → <style>（样式里的 url() 转 data:）
 *  - <img src="相对路径"> → data: URI
 * 只认相对路径（不含协议、不以 / 开头），同样经工作目录核对与类型限制；单个资源与总量都有上限。
 * 页面运行时再用 fetch 读的本地文件不在此列。
 */
const INLINE_ONE_MAX = 3 * 1024 * 1024;
const INLINE_TOTAL_MAX = 15 * 1024 * 1024;
export function inlineHtmlAssets(html: string, workspace: string, htmlRel: string, opts: { scripts?: boolean } = {}): string {
  let budget = INLINE_TOTAL_MAX;
  const dir = htmlRel.includes("/") ? htmlRel.slice(0, htmlRel.lastIndexOf("/")) : "";
  const isLocal = (u: string) => !!u && !/^[a-z][a-z0-9+.-]*:/i.test(u) && !u.startsWith("//") && !u.startsWith("/") && !u.startsWith("#");
  const join = (base: string, u: string) => {
    const parts = (base ? base.split("/") : []);
    for (const seg of u.split(/[?#]/)[0]!.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") { if (!parts.length) return undefined; parts.pop(); } else parts.push(seg);
    }
    return parts.join("/");
  };
  const read = (base: string, u: string): { text: () => string; dataUri: () => string; rel: string } | undefined => {
    if (!isLocal(u)) return undefined;
    const rel = join(base, decodeSafe(u));
    if (!rel) return undefined;
    const f = resolveSessionAsset(workspace, rel);
    if (!f.ok || f.size > INLINE_ONE_MAX || f.size > budget) return undefined;
    budget -= f.size;
    const buf = readFileSync(f.real);
    return { rel, text: () => buf.toString("utf8"), dataUri: () => `data:${f.mediaType.split(";")[0]};base64,${buf.toString("base64")}` };
  };
  const cssUrls = (css: string, base: string) => css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q: string, u: string) => {
    const a = read(base, u.trim());
    return a ? `url("${a.dataUri()}")` : m;
  });
  const dirOf = (rel: string) => rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  /** 属性值：带引号和不带引号都读（手写的 HTML 常写 <link rel=stylesheet href=s.css>） */
  const attrValue = (tag: string, name: string): string | undefined => {
    const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
    return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
  };
  const scriptTags = opts.scripts === false
    ? html
    : html.replace(/<script\b([^>]*?)\ssrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script\s*>/gi, (m, pre: string, _q: string, u: string, post: string) => {
      const a = read(dir, u);
      return a ? `<script${pre}${post}>${a.text().replace(/<\/script/gi, "<\\/script")}</script>` : m;
    });
  return scriptTags
    .replace(/<link\b[^>]*>/gi, (m) => {
      if (!/\brel\s*=\s*(["']?)[^"'>]*stylesheet/i.test(m)) return m;
      const href = attrValue(m, "href");
      const a = href ? read(dir, href) : undefined;
      return a ? `<style>${cssUrls(a.text(), dirOf(a.rel)).replace(/<\/style/gi, "<\\/style")}</style>` : m;
    })
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = attrValue(tag, "src");
      const a = src ? read(dir, src) : undefined;
      return a ? tag.replace(/(\bsrc\s*=\s*)("[^"]*"|'[^']*'|[^\s"'>]+)/i, (_m, pre: string) => `${pre}"${a.dataUri()}"`) : tag;
    });
}
function decodeSafe(u: string): string { try { return decodeURI(u); } catch { return u; } }

/**
 * HTML 缩略图：内联同目录的样式与图片，然后去掉所有脚本，配合 SESSION_FILE_CSP 下发。
 * 得到的是一帧静态快照——不执行脚本、不发请求；点开才走上面的交互预览。
 */
export function staticHtmlForThumb(html: string, workspace: string, htmlRel: string): string {
  return inlineHtmlAssets(html, workspace, htmlRel, { scripts: false })
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<script\b[^>]*\/?>/gi, "");
}
