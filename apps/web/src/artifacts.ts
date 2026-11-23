import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTIFACT_PRODUCTS, type ArtifactProduct } from "./artifact-products.js";
import { fileURLToPath } from "node:url";

/**
 * 产物库：平台里"可以直接玩的东西"（V3.9）。
 *
 * 目前只有「小游戏」一个分类，里面的项目就是仓库 apps/pet-math-game 的源码——
 * 单一来源，不往 apps/web/public 里拷副本。服务端只按白名单吐运行时文件，
 * 所以既不需要构建步骤，也不可能被路径穿越读到别的东西。
 *
 * 版本号 = 全部运行时文件的内容哈希。它同时是 Service Worker 的缓存名，
 * 所以"服务端版本变了"就等于"该更新本地缓存了"。
 */

const HERE = dirname(fileURLToPath(import.meta.url));

/** kind="eval"：评测产物分类，内容由 eval-artifacts.ts 提供，页面单独渲染 */
export type ArtifactCategory = { id: string; name: string; description: string; kind?: "eval" };

export type ArtifactSummary = {
  id: string;
  category: string;
  name: string;
  emoji: string;
  accent: string;
  summary: string;
  description: string;
  tags: string[];
  version: string;
  /** 相对入口，页面用它拼 iframe / 新窗口地址 */
  entry: string;
  /** 里面是孩子的隐私数据（作业照片等）：不提供分享链接 */
  private?: boolean;
};

type Source = ArtifactSummary & { root: string };

const CATEGORIES: ArtifactCategory[] = [
  { id: "games", name: "小游戏", description: "点开就能玩。玩过一次后会缓存到本机，断网也能打开。" },
  { id: "evals", name: "评测产物", description: "固定评测任务在各 runtime、各版本下跑出的结果，可以并排对比。", kind: "eval" },
];

/** 名称 / 分类 / 概览 / 标签只登记在 artifact-products.ts：分类器和产物库共用同一份数据。 */
const product = (id: string): ArtifactProduct => {
  const found = ARTIFACT_PRODUCTS.find(item => item.id === id);
  if (!found) throw Error(`产物 ${id} 没有在 artifact-products.ts 登记`);
  return found;
};

const SOURCES: Source[] = [
  {
    ...product("pet-math-game"),
    emoji: "🦄",
    accent: "#7fb7e8",
    description:
      "天上掉下不同能量的食物，算对口算就能喂给小马宝莉：算得越快，食物能量越高，小马长得越快。24 个关卡每关只学一个新本领，从表内加减乘除一路递进到四则混合；答错的题会反复出现，又快又准的题逐渐减少，还有薄弱题专项加练。两个小朋友还能在同一台手机上左右对战，赢的人可以拿走对方一件礼物或一匹小马。",
    version: "",
    entry: "/games/pet-math-game/",
    root: join(HERE, "../../pet-math-game"),
  },
  {
    ...product("challenge-island"),
    emoji: "🌟",
    accent: "#ffcf3d",
    description:
      "给三年级小朋友的挑战目标小游戏：和爸爸妈妈一起定下每天、每周的小目标（阅读、口算、运动、整理书包……），完成后拍照打卡，进度换成星星；心愿池里的礼物各有价格，攒够了就能兑换，兑换后会扣掉星星并留下记录。打卡和兑换都有烟花结算动画。记录、照片和星星会同步到家里的 Mac Mini，换手机不会丢；也可以生成家庭分享链接，让另一台手机一起用。",
    version: "",
    entry: "/games/challenge-island/",
    root: join(HERE, "../../challenge-island"),
  },
  {
    ...product("wrong-book"),
    emoji: "📒",
    accent: "#f0a35e",
    description:
      "给三年级小朋友的上海数学错题本：爸爸妈妈把学校考试和每天的作业拍下来，AI 把习题整理成结构化的题目（记下日期、年级、知识点），确认后放进错题本，还能转成网页查看。每周按设定的时间，根据错题和知识点掌握情况出一份专属小测验：补弱、温习刚学会的、再把熟练的知识点适当拔高；每道题都经过独立重解核对。做完每道题都有讲解，用生活里的例子和一步一步的动画讲给小朋友听。",
    version: "",
    entry: "/games/wrong-book/",
    private: true,
    root: join(HERE, "../../wrong-book"),
  },
  {
    ...product("word-detective"),
    emoji: "🕵️",
    accent: "#e0a868",
    description:
      "每句英语话里都住着三个角色：谁（主语）、做什么（动词）、对什么（宾语）。先把它们一一点出来，再把陈述句变成疑问句——问东西用 What、问人用 Who、问是不是把 Do/Does 搬到最前面。六个案逐层教一个规则，答错时侦探猫只说孩子听得懂的那一句：does 会把 -s 收走、问「谁」不用帮手。",
    version: "",
    entry: "/games/word-detective/",
    root: join(HERE, "../../word-detective"),
  },
  {
    ...product("ring-toss"),
    emoji: "⭕",
    accent: "#eb523d",
    description:
      "还原夜市套圈手感：开局先确定拿几个圈，再确认要摆上摊位的奖品（支持自定义真实兑奖清单）。进入摊位后手指从圈往上滑，根据力道、速度与甩弧控制投掷距离、方向和旋转；3D 物理碰撞与震动触感覆盖出手、砸奖品、弹跳与最终套中，套中就真的归你。",
    version: "",
    entry: "/games/ring-toss/",
    root: join(HERE, "../../ring-toss"),
  },
];

/**
 * 分类器用的产物清单：只带名称 / 分类 / 概览 / 标签，不读文件系统、不带路径。
 * 待办分类的实体词表从这里取产品名与标签（单一来源）：新增一个小游戏只要在上面登记一次，
 * 分类器下次启动就认得它，不用再改提示词。
 */
export { ARTIFACT_PRODUCTS };

/** 只允许这几个入口文件；其余一律 404（路径穿越因此不成立） */
const TOP_FILES = [
  "index.html",
  "styles.css",
  "sw.js",
  "manifest.webmanifest",
  "icon.svg",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  webmanifest: "application/manifest+json",
  woff2: "font/woff2",
};

function listFiles(root: string): string[] {
  const files = TOP_FILES.filter((name) => existsSync(join(root, name)));
  const jsDir = join(root, "js");
  if (existsSync(jsDir) && statSync(jsDir).isDirectory()) {
    for (const name of readdirSync(jsDir).sort()) {
      if (/^[a-z][a-z0-9-]*\.js$/.test(name)) files.push("js/" + name);
    }
  }
  // 手写字体：随产物发布，只有 .woff2 会进白名单（字体名称固定，不接受任意文件）。
  const fontDir = join(root, "fonts");
  if (existsSync(fontDir) && statSync(fontDir).isDirectory()) {
    for (const name of readdirSync(fontDir).sort()) {
      if (/^[a-z][a-z0-9-]*\.woff2$/.test(name)) files.push("fonts/" + name);
    }
  }
  if (!files.includes("index.html")) return [];
  return files.sort();
}

export class ArtifactLibrary {
  private cache = new Map<string, { at: number; files: string[]; version: string }>();
  private ttlMs = 3000;

  private scan(source: Source) {
    const hit = this.cache.get(source.id);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit;
    const files = listFiles(source.root);
    const hash = createHash("sha256");
    hash.update(source.id);
    for (const rel of files) {
      hash.update("\u0000" + rel + "\u0000");
      hash.update(readFileSync(join(source.root, rel)));
    }
    const entry = { at: now, files, version: hash.digest("hex").slice(0, 16) };
    this.cache.set(source.id, entry);
    return entry;
  }

  private source(id: string): Source | undefined {
    return SOURCES.find((item) => item.id === id);
  }

  /** 页面用：分类 + 每个产物的版本与地址 */
  catalog() {
    const items = SOURCES.map((source) => {
      const { version } = this.scan(source);
      const { root: _root, version: _version, ...rest } = source;
      return { ...rest, version };
    });
    return { schema: 1, categories: CATEGORIES, items };
  }

  version(id: string): string | null {
    const source = this.source(id);
    if (!source) return null;
    const { files, version } = this.scan(source);
    if (!files.length) return null;
    return version;
  }

  /** Service Worker 用它知道"这个版本该缓存哪些文件" */
  versionManifest(id: string): { schema: 1; version: string; files: string[] } | null {
    const source = this.source(id);
    if (!source) return null;
    const { files, version } = this.scan(source);
    if (!files.length) return null;
    return { schema: 1, version, files };
  }

  /** 读一个运行时文件；不在白名单里就返回 null */
  read(id: string, relPath: string): { body: Buffer; type: string } | null {
    const source = this.source(id);
    if (!source) return null;
    const rel = relPath.replace(/^\/+/, "").replace(/\/+$/, "") || "index.html";
    if (rel.includes("..") || rel.includes("\\") || rel.includes("\u0000")) return null;
    const { files } = this.scan(source);
    if (!files.includes(rel)) return null;
    const ext = rel.slice(rel.lastIndexOf(".") + 1);
    return { body: readFileSync(join(source.root, rel)), type: MIME[ext] ?? "application/octet-stream" };
  }
}

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  // 只允许控制台自己嵌入（点击劫持防线）
  "frame-ancestors 'self'",
].join("; ");
