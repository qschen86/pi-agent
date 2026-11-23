/**
 * 产物分享：管理接口（/api/artifact-shares，只有控制台主人能用）+ 对外访问页（/share/<id>/）。
 *
 * /share/ 是控制台里唯一不需要控制台登录的路径（Cloudflare Access 对它单独放行）。
 * 这里只会吐出被分享的那一个产物的运行时文件，访问前必须输入分享密码，并且绑定设备。
 */
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash } from "node:crypto";
import { ARTIFACT_CSP, type ArtifactLibrary } from "./artifacts.js";
import { ArtifactShares, SHARE_ID_RE, ShareInputError, type ArtifactShare } from "./artifact-shares.js";
import { preferredOrigin } from "./entry-origin.js";

/**
 * 可选应用挂到分享页上的扩展（例如心愿挑战岛的打卡接口）。
 * 分享页只对 artifactId 对应的分享开放：`authorize` 凭分享 cookie 校验，`base` 是 `/share/:id`。
 */
export interface ShareExtension {
  artifactId: string;
  mount(app: Hono, ctx: { base: string; authorize: (c: Context) => boolean }): void;
}

export const SHARE_PREFIX = "/share/";
export const isSharePath = (path: string) => path === "/share" || path.startsWith(SHARE_PREFIX);

const COOKIE = "pi_share";
const PAGE_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = { "content-security-policy": PAGE_CSP, "cache-control": "no-store", "referrer-policy": "no-referrer" };

const SHARE_CSS = `*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:20px;font-family:-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",system-ui,sans-serif;color:#23304a;background:linear-gradient(170deg,#eaf6ff,#f7f0ff 55%,#fff6ea)}
.card{width:100%;max-width:380px;background:#fff;border-radius:24px;padding:26px 22px;box-shadow:0 18px 48px rgba(35,48,74,.16);text-align:center}
.emoji{font-size:54px;line-height:1}h1{font-size:22px;margin:10px 0 4px}p{color:#5b6b8a;line-height:1.6;margin:6px 0}
.err{color:#b91c1c;background:#fff1f1;border-radius:12px;padding:8px 10px;font-weight:700}
label{display:block;text-align:left;font-weight:700;font-size:14px;color:#5b6b8a;margin-top:16px}
.filled{color:#166534;background:#ecfdf3;border-radius:12px;padding:8px 10px;font-weight:700}
input{width:100%;margin-top:6px;font:inherit;font-size:20px;padding:12px 14px;border-radius:14px;border:2px solid #e4ebf6;outline:none}input:focus{border-color:#4f8cf7}
button{width:100%;margin-top:14px;font:inherit;font-size:18px;font-weight:800;padding:14px;border:0;border-radius:16px;color:#fff;background:linear-gradient(180deg,#4f8cf7,#2f6ee0);cursor:pointer}button:focus-visible{outline:3px solid #93b8ff;outline-offset:2px}
small{display:block;margin-top:14px;color:#8b98b3;font-size:12px;line-height:1.5}
@media (prefers-color-scheme:dark){body{background:linear-gradient(170deg,#101827,#151227 55%,#1b1616);color:#e6ecf7}.card{background:#1a2130;box-shadow:0 18px 48px rgba(0,0,0,.55)}p{color:#a9b7cd}label{color:#a9b7cd}input{background:#111823;color:#e6ecf7;border-color:#2b3648}input:focus{border-color:#5b95f8}.err{background:#3a1c1c;color:#ffb4b4}.filled{background:#122a1e;color:#8fe0b0}small{color:#8593ab}}`;

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title><link rel="stylesheet" href="/share/_/share.css"></head><body><main class="card">${body}</main></body></html>`;
}

export function mountShareRoutes(app: Hono, deps: { artifacts: ArtifactLibrary; shares: ArtifactShares; publicHosts: string[]; preferredOrigin?: string | null; extensions?: ShareExtension[] }) {
  const { artifacts, shares } = deps;
  // 分享链接优先用国内备用入口（deps.preferredOrigin 显式传 null 表示不用）；没有再退回第一个对外域名/请求自身的源。
  const preferred = deps.preferredOrigin === undefined ? preferredOrigin() : deps.preferredOrigin;
  const origin = (c: Context) => preferred ?? (deps.publicHosts[0] ? `https://${deps.publicHosts[0]}` : new URL(c.req.url).origin);
  const urlOf = (c: Context, id: string) => `${origin(c)}${SHARE_PREFIX}${id}/`;
  // 邀请链接：密码带在 ?pw= 里，对方打开后密码框已经填好，点「进入」才登录。
  // 只是页面上的预填，服务端照旧校验密码与设备名额，链接本身不等于已授权。
  const inviteUrlOf = (c: Context, id: string, password: string | undefined) => (password ? `${urlOf(c, id)}?pw=${encodeURIComponent(password)}` : null);
  const pwPrefill = (c: Context) => (c.req.query("pw") ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 64);
  const nameOf = (artifactId: string) => artifacts.catalog().items.find((item) => item.id === artifactId) ?? null;

  /* ---------------- 管理接口（受控制台登录保护） ---------------- */
  app.get("/api/artifact-shares", (c) => {
    c.header("Cache-Control", "private, no-store");
    const artifact = c.req.query("artifact");
    return c.json({ shares: shares.list(artifact || undefined).map((s) => ({ ...s, url: urlOf(c, s.id), inviteUrl: inviteUrlOf(c, s.id, s.password) })) });
  });

  app.post("/api/artifact-shares", async (c) => {
    let body: { artifactId?: unknown; password?: unknown; label?: unknown; expiresInDays?: unknown; maxDevices?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "请求格式不对" }, 400); }
    const artifactId = typeof body.artifactId === "string" ? body.artifactId : "";
    const target = nameOf(artifactId);
    if (!target) return c.json({ error: "没有这个产物" }, 400);
    if (target.private) return c.json({ error: "这个产物里有孩子的作业照片和成绩，不能分享" }, 400);
    try {
      const share = shares.create({
        artifactId,
        password: typeof body.password === "string" ? body.password : "",
        label: typeof body.label === "string" ? body.label : "",
        expiresInDays: body.expiresInDays == null ? null : Number(body.expiresInDays),
        maxDevices: body.maxDevices == null ? 1 : Number(body.maxDevices),
      });
      return c.json({ share: { ...shares.toPublic(share), url: urlOf(c, share.id), inviteUrl: inviteUrlOf(c, share.id, share.password) } }, 201);
    } catch (e) {
      if (e instanceof ShareInputError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  for (const [action, fn] of [["revoke", (id: string) => shares.revoke(id)], ["reset-devices", (id: string) => shares.resetDevices(id)], ["delete", (id: string) => shares.remove(id)]] as const) {
    app.post(`/api/artifact-shares/:id/${action}`, (c) => c.json({ ok: fn(c.req.param("id")) }));
  }

  /* ---------------- 对外访问（不需要控制台登录） ---------------- */
  app.get("/share/_/share.css", (c) => c.body(SHARE_CSS, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" }));

  const secure = (c: Context) => c.req.header("x-forwarded-proto") === "https" || (c.req.header("cf-visitor") ?? "").includes("https") || new URL(c.req.url).protocol === "https:";

  const lockedPage = (share: ArtifactShare | null, error?: string, prefill = "") => {
    const item = share ? nameOf(share.artifactId) : null;
    return page(item ? item.name : "分享", `<div class="emoji">${item ? esc(item.emoji) : "🔒"}</div><h1>${esc(item ? item.name : "分享链接")}</h1>
<p>这是一个私人分享，需要分享人告诉你的密码。</p>${error ? `<p class="err">${esc(error)}</p>` : ""}${prefill ? '<p class="filled">密码已带在链接里，点「进入」即可。</p>' : ""}
<form method="post" action="unlock"><label>访问密码<input type="password" name="password" autocomplete="off" required maxlength="64"${prefill ? ` value="${esc(prefill)}"` : " autofocus"}></label><button type="submit"${prefill ? " autofocus" : ""}>进入</button></form>
<small>输对密码后，这个链接会和本机绑定，换别的设备需要分享人重新开放。</small>`);
  };

  const gone = (c: Context) => c.html(page("链接已失效", `<div class="emoji">🔒</div><h1>链接无效或已失效</h1><p>这个分享链接不存在、已被撤销或已过期。请联系分享人。</p>`), 404, PAGE_HEADERS);

  app.get("/share/:id", (c) => {
    const id = c.req.param("id");
    // 带上 ?pw= 的一起转过去，别把密码丢在跳转里
    return SHARE_ID_RE.test(id) ? c.redirect(`${SHARE_PREFIX}${id}/${new URL(c.req.url).search}`, 302) : gone(c);
  });

  app.post("/share/:id/unlock", async (c) => {
    const id = c.req.param("id");
    const share = shares.get(id);
    if (!share) return gone(c);
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const password = typeof form["password"] === "string" ? form["password"] : "";
    const result = shares.unlock(id, password, c.req.header("user-agent") ?? "");
    if (result.ok) {
      const maxAge = share.expiresAt ? Math.max(60, Math.floor((Date.parse(share.expiresAt) - Date.now()) / 1000)) : 365 * 86400;
      setCookie(c, COOKIE, result.token, { path: `${SHARE_PREFIX}${id}/`, httpOnly: true, sameSite: "Lax", secure: secure(c), maxAge });
      return c.redirect(`${SHARE_PREFIX}${id}/`, 303);
    }
    if (result.reason === "not-found") return gone(c);
    if (result.reason === "device-limit") {
      return c.html(page("已在其他设备使用", `<div class="emoji">📵</div><h1>这个链接已经在别的设备上打开过了</h1>
<p>为了防止转发，这个分享只能在 ${share.maxDevices} 台设备上使用。如果是你本人换了设备，请联系分享人重新开放。</p>`), 403, PAGE_HEADERS);
    }
    if (result.reason === "locked") {
      const minutes = Math.ceil((result.retryAfterSec ?? 900) / 60);
      return c.html(lockedPage(share, `密码错误次数太多，请约 ${minutes} 分钟后再试`), 429, { ...PAGE_HEADERS, "retry-after": String(result.retryAfterSec ?? 900) });
    }
    await new Promise((r) => setTimeout(r, 800)); // 拖慢猜密码
    return c.html(lockedPage(share, "密码不对"), 401, PAGE_HEADERS);
  });

  // 可选应用的分享扩展（如心愿挑战岛的打卡 / 兑换 / 照片）：只对各自产物的分享开放，凭分享 cookie 授权。
  // 路由要排在下面的静态文件兜底之前，否则会被当成产物文件 404。
  // 独立版里未发布的扩展只有空桩（调用后返回 undefined）：跳过去，不能让一个空桩把整套 API 带下水。
  for (const extension of deps.extensions ?? []) {
    if (!extension || typeof extension.mount !== "function") continue;
    extension.mount(app, {
      base: `${SHARE_PREFIX}:id`,
      authorize: (c) => {
        const share = shares.authorize(c.req.param("id") ?? "", getCookie(c, COOKIE));
        return !!share && share.artifactId === extension.artifactId;
      },
    });
  }

  app.get("/share/:id/*", (c) => {
    const id = c.req.param("id");
    const pathname = new URL(c.req.url).pathname;
    let rel = "index.html";
    try { rel = decodeURIComponent(pathname.slice(`${SHARE_PREFIX}${id}/`.length)) || "index.html"; } catch { return gone(c); }
    const share = shares.authorize(id, getCookie(c, COOKIE));
    if (!share) {
      if (!shares.get(id)) return gone(c);
      // 只有入口页给密码框；其他文件一律不给
      return rel === "index.html" ? c.html(lockedPage(shares.get(id), undefined, pwPrefill(c)), 401, PAGE_HEADERS) : c.json({ error: "需要密码" }, 401, { "cache-control": "no-store" });
    }
    let payload: { body: Buffer; type: string } | null;
    if (rel === "version.json") {
      const manifest = artifacts.versionManifest(share.artifactId);
      payload = manifest ? { body: Buffer.from(JSON.stringify(manifest)), type: "application/json; charset=utf-8" } : null;
    } else {
      payload = artifacts.read(share.artifactId, rel);
    }
    if (!payload) return c.json({ error: "not found" }, 404);
    if (rel === "index.html") shares.touchOpen(id);
    const etag = `"${createHash("sha256").update(payload.body).digest("hex").slice(0, 32)}"`;
    const headers = {
      "content-type": payload.type,
      // 撤销后要立刻生效：一律回源校验，不让浏览器长期缓存
      "cache-control": "private, no-cache",
      "content-security-policy": ARTIFACT_CSP,
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
      etag,
    };
    const validators = c.req.header("if-none-match")?.split(",").map((tag) => tag.trim().replace(/^W\//, ""));
    if (validators?.some((tag) => tag === "*" || tag === etag)) return c.body(null, 304, headers);
    return c.body(new Uint8Array(payload.body), 200, headers);
  });
}
