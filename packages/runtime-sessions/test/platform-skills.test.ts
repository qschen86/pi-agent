import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLATFORM_SKILLS_ROOT, USER_MESSAGE_MARK, expandPlatformSkills, listPlatformSkills, mentionedPlatformSkills, platformSkillIndex, preparePlatformPrompt, userVisiblePrompt } from "../src/platform-skills.js";
import { RuntimeStore } from "../src/store.js";
import { LIMITS } from "../src/redact.js";
import { RuntimeSessionManager } from "../src/manager.js";
import { FakeDriver, until, tick } from "./fake-driver.js";

let root: string;
const skill = (dir: string, front: string, body = "第一步：做事。\n工具在 <SKILL_DIR>/toolkit/run.py") => {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\n${front}\n---\n\n${body}\n`);
};
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "platform-skills-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("platform skill registry", () => {
  it("lists valid skills and silently skips broken, duplicate and oversize ones", () => {
    skill("promo", "name: 产品宣传视频\nid: product-promo-video\ndescription: 做宣传片");
    skill("no-desc", "name: 缺描述\nid: no-desc");
    skill("bad-id", "name: 坏标识\nid: Bad_ID\ndescription: x");
    skill("zdup", "name: 产品宣传视频\nid: other-id\ndescription: 重名");
    skill("huge", "name: 太长\nid: huge\ndescription: x", "字".repeat(12_001));
    mkdirSync(join(root, "empty"));
    writeFileSync(join(root, "plain.md"), "not a skill");
    expect(listPlatformSkills(root)).toEqual([{ id: "product-promo-video", name: "产品宣传视频", description: "做宣传片", trigger: "/产品宣传视频" }]);
    expect(listPlatformSkills(join(root, "missing"))).toEqual([]);
  });

  it("picks up edits to a SKILL.md without a restart", () => {
    skill("promo", "name: 产品宣传视频\nid: promo\ndescription: 旧描述");
    expect(listPlatformSkills(root)[0]!.description).toBe("旧描述");
    skill("promo", "name: 产品宣传视频\nid: promo\ndescription: 新描述，更长一点");
    expect(listPlatformSkills(root)[0]!.description).toBe("新描述，更长一点");
  });

  it("only treats /name or /id at the start of a line as an invocation", () => {
    skill("promo", "name: 产品宣传视频\nid: promo\ndescription: d");
    const hit = (p: string) => mentionedPlatformSkills(p, root).map((s) => s.id);
    expect(hit("/产品宣传视频 给 Achat 做一支")).toEqual(["promo"]);
    expect(hit("/promo")).toEqual(["promo"]);
    expect(hit("先看看这个\n  /产品宣传视频\n再说")).toEqual(["promo"]);
    expect(hit("请使用 /产品宣传视频 来做")).toEqual([]);   // 行中不触发
    expect(hit("/产品宣传视频中的卖点")).toEqual([]);        // 后面必须是空白或行尾
    expect(hit("//产品宣传视频")).toEqual([]);
    expect(hit("普通消息")).toEqual([]);
  });

  it("expands to skill text + the user's message verbatim, and leaves other prompts untouched", () => {
    skill("promo", "name: 产品宣传视频\nid: promo\ndescription: d");
    const plain = "没有调用技能";
    expect(expandPlatformSkills(plain, root)).toEqual({ prompt: plain, skills: [] });
    const user = "/产品宣传视频 给 Achat 做 45 秒\n卖点：群聊、手机端";
    const out = expandPlatformSkills(user, root);
    expect(out.skills.map((s) => s.name)).toEqual(["产品宣传视频"]);
    expect(out.prompt.startsWith("【平台技能：产品宣传视频】")).toBe(true);
    expect(out.prompt.endsWith(`【用户消息】\n${user}`)).toBe(true);
    expect(out.prompt).toContain("第一步：做事。");
    // <SKILL_DIR> 变成真实的（realpath）技能目录，不留占位符
    expect(out.prompt).not.toContain("<SKILL_DIR>");
    expect(out.prompt).toMatch(/\/promo\/toolkit\/run\.py/);
  });

  it("expands several distinct skills in order of appearance", () => {
    skill("a", "name: 甲技能\nid: skill-a\ndescription: d");
    skill("b", "name: 乙技能\nid: skill-b\ndescription: d");
    const out = expandPlatformSkills("/乙技能 先做\n/甲技能 再做", root);
    expect(out.skills.map((s) => s.id)).toEqual(["skill-b", "skill-a"]);
  });
});

describe("what the conversation shows (the injected text must not leak into the user's bubble)", () => {
  const user = "帮我给 Achat 做一支发布视频\n要 45 秒";
  const both = () => {
    skill("a", "name: 甲技能\nid: skill-a\ndescription: 当用户要做甲类事情时使用。做甲。");
    skill("b", "name: 乙技能\nid: skill-b\ndescription: 当用户要做乙类事情时使用。做乙。");
  };

  it("returns exactly what the user wrote for index-only, expansion-only and index+expansion prompts", () => {
    both();
    for (const text of [user, `/甲技能 ${user}`, `/乙技能\n${user}`]) {
      const sent = preparePlatformPrompt(text, { firstTurn: true, root });
      expect(sent.prompt).not.toBe(text);
      expect(userVisiblePrompt(sent.prompt), text).toBe(text);
    }
  });

  it("leaves everything else alone", () => {
    expect(userVisiblePrompt("普通消息")).toBe("普通消息");
    expect(userVisiblePrompt("")).toBe("");
    expect(userVisiblePrompt("【平台技能】我自己写的，没有分隔")).toBe("【平台技能】我自己写的，没有分隔");
    expect(userVisiblePrompt(`我先说：${USER_MESSAGE_MARK}后面`)).toBe(`我先说：${USER_MESSAGE_MARK}后面`);   // 不以平台标记开头
    // 用户原文里恰好带分隔线：只在第一处切开，后面的原样保留
    const sent = preparePlatformPrompt(`引用：${USER_MESSAGE_MARK}x`, { firstTurn: true, root: (both(), root) });
    expect(userVisiblePrompt(sent.prompt)).toBe(`引用：${USER_MESSAGE_MARK}x`);
  });

  it("the separator always lands before the runtime's 20000-char echo cap, even for the largest allowed skill", () => {
    skill("big", "name: 大技能\nid: big-skill\ndescription: 当用户要做大事时使用。", "字".repeat(12_000));
    const sent = preparePlatformPrompt(`/大技能 ${"问".repeat(30_000)}`, { firstTurn: true, root }).prompt;
    const echoed = sent.slice(0, LIMITS.message);                  // runtime 回显被截断后的样子
    expect(echoed.includes(USER_MESSAGE_MARK)).toBe(true);
    expect(userVisiblePrompt(echoed).startsWith("/大技能 ")).toBe(true);
  });

  it("the event store keeps only the user's part, for new events and for events written to disk before this fix", () => {
    both();
    const dir = mkdtempSync(join(tmpdir(), "rt-skill-store-"));
    try {
      const store = new RuntimeStore(dir);
      const sent = preparePlatformPrompt(user, { firstTurn: true, root }).prompt;
      const base = { kind: "message" as const, source: "stream" as const, parserVersion: "t", availability: "recorded" as const, recordedAt: "2026-10-18T00:00:00Z" };
      store.upsertEvent("s1", { ...base, key: "pi:user:1", role: "user", text: sent });
      store.upsertEvent("s1", { ...base, key: "pi:asst:1", role: "assistant", text: sent });          // 只处理用户消息
      expect(store.events("s1").map((e) => e.text)).toEqual([user, sent]);

      // 修复前已经落盘的事件：重新加载时也还原
      writeFileSync(join(store.dir, "events", "old.jsonl"), `${JSON.stringify({ ...base, key: "pi:user:0", role: "user", text: sent, seq: 1 })}\n`);
      expect(new RuntimeStore(dir).events("old").map((e) => e.text)).toEqual([user]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("skill index (first-turn self-invocation)", () => {
  const two = () => {
    skill("a", "name: 甲技能\nid: skill-a\ndescription: 当用户要做甲类事情时使用。做甲。");
    skill("b", "name: 乙技能\nid: skill-b\ndescription: 当用户要做乙类事情时使用。做乙。");
  };

  it("lists name, trigger, when-to-use description and the SKILL.md path; empty without skills", () => {
    expect(platformSkillIndex(root)).toBe("");
    two();
    const index = platformSkillIndex(root);
    expect(index).toContain("【平台技能】");
    expect(index).toMatch(/- 甲技能（\/甲技能）：当用户要做甲类事情时使用。做甲。 说明文件：.*\/a\/SKILL\.md/);
    expect(index).toMatch(/- 乙技能（\/乙技能）：当用户要做乙类事情时使用。做乙。 说明文件：.*\/b\/SKILL\.md/);
    expect(platformSkillIndex(root, ["skill-a"])).not.toContain("甲技能（");
    expect(platformSkillIndex(root, ["skill-a", "skill-b"])).toBe("");
    expect(index.length).toBeLessThan(1500);   // 目录只放名称、描述和路径，不放技能正文
    expect(index).not.toContain("做事。");
  });

  it("first turn: index + the user's message verbatim; later turns: untouched", () => {
    two();
    const user = "帮我整理周报\n要简短";
    const first = preparePlatformPrompt(user, { firstTurn: true, root });
    expect(first.prompt.startsWith("【平台技能】")).toBe(true);
    expect(first.prompt.endsWith(`【用户消息】\n${user}`)).toBe(true);
    expect(first.skills).toEqual([]);
    expect(first.indexed.map((k) => k.id)).toEqual(["skill-a", "skill-b"]);
    expect(preparePlatformPrompt(user, { firstTurn: false, root })).toEqual({ prompt: user, skills: [], indexed: [] });
    expect(preparePlatformPrompt("x", { firstTurn: true, root: join(root, "missing") })).toEqual({ prompt: "x", skills: [], indexed: [] });
  });

  it("exclude: the excluded skill is absent from the first-turn index (clean eval baseline); an explicit /skill still expands", () => {
    two();
    const user = "做点事";
    const out = preparePlatformPrompt(user, { firstTurn: true, root, exclude: ["skill-a"] });
    expect(out.prompt).not.toContain("甲技能");
    expect(out.prompt).toContain("乙技能（/乙技能）");
    expect(out.indexed.map((k) => k.id)).toEqual(["skill-b"]);
    expect(out.prompt.endsWith(`【用户消息】\n${user}`)).toBe(true);
    // 全部排除 = 和没有任何技能一样，原样返回
    expect(preparePlatformPrompt(user, { firstTurn: true, root, exclude: ["skill-a", "skill-b"] })).toEqual({ prompt: user, skills: [], indexed: [] });
    // 排除只管目录，用户自己写 /甲技能 仍然展开
    expect(preparePlatformPrompt("/甲技能 做", { firstTurn: true, root, exclude: ["skill-a"] }).skills.map((k) => k.id)).toEqual(["skill-a"]);
    // 没传 exclude 时行为不变
    expect(preparePlatformPrompt(user, { firstTurn: true, root }).indexed.map((k) => k.id)).toEqual(["skill-a", "skill-b"]);
  });

  it("an explicit /skill is expanded in full and not listed again; other skills are still indexed", () => {
    two();
    const user = "/甲技能 现在就做";
    const out = preparePlatformPrompt(user, { firstTurn: true, root });
    expect(out.skills.map((k) => k.id)).toEqual(["skill-a"]);
    expect(out.indexed.map((k) => k.id)).toEqual(["skill-b"]);
    expect(out.prompt.match(/【平台技能：甲技能】/g)).toHaveLength(1);
    expect(out.prompt).not.toContain("甲技能（/甲技能）");          // 目录里没有重复的甲
    expect(out.prompt).toContain("乙技能（/乙技能）");
    expect(out.prompt.indexOf("【平台技能】")).toBeLessThan(out.prompt.indexOf("【平台技能：甲技能】"));
    expect(out.prompt.endsWith(`【用户消息】\n${user}`)).toBe(true);
    // 只有一个技能且被调用：不再有目录
    rmSync(join(root, "b"), { recursive: true });
    const solo = preparePlatformPrompt(user, { firstTurn: true, root });
    expect(solo.indexed).toEqual([]);
    expect(solo.prompt).toBe(expandPlatformSkills(user, root).prompt);
  });
});

describe("repository skill 产品宣传视频", () => {
  it("is registered at platform level and every <SKILL_DIR> path it names exists", () => {
    const [promo] = listPlatformSkills().filter((s) => s.id === "product-promo-video");
    expect(promo).toMatchObject({ name: "产品宣传视频", trigger: "/产品宣传视频" });
    const text = readFileSync(join(PLATFORM_SKILLS_ROOT, "product-promo-video", "SKILL.md"), "utf8");
    const paths = [...text.matchAll(/<SKILL_DIR>\/([\w./{},-]+)/g)].map((m) => m[1]!.replace(/[.,]+$/, ""));
    expect(paths.length).toBeGreaterThan(3);
    for (const p of paths) {
      const m = /^(.*)\/\{([^}]+)\}$/.exec(p);                      // examples/achat/{a,b}
      for (const rel of m ? m[2]!.split(",").map((f) => `${m[1]}/${f}`) : [p.replace(/\/$/, "")]) {
        expect(existsSync(join(PLATFORM_SKILLS_ROOT, "product-promo-video", rel)), rel).toBe(true);
      }
    }
    for (const f of ["timeline.py", "build_audio.py", "build_html.py", "beat-clock.js", "verify_sync.py", "check_delivery.py"]) expect(existsSync(join(PLATFORM_SKILLS_ROOT, "product-promo-video", "toolkit", f)), f).toBe(true);
    // 展开后的提示词必须放得进消息上限
    expect(expandPlatformSkills("/产品宣传视频 x").prompt.length).toBeLessThan(60_000);
  });

  it("defaults to 30fps and always emits a 720p30 mobile preview", () => {
    const root = join(PLATFORM_SKILLS_ROOT, "product-promo-video");
    const text = readFileSync(join(root, "SKILL.md"), "utf8");
    expect(text).toContain('"fps": 30');
    expect(text).toContain("-mobile.mp4");
    expect(text).toContain("check_delivery.py");
    expect(JSON.parse(readFileSync(join(root, "examples/achat/video.config.json"), "utf8")).fps).toBe(30);
    expect(readFileSync(join(root, "toolkit/timeline.py"), "utf8")).toContain('CFG.get("fps", 30)');
  });

  it("the description says WHEN to use it (that is what lets a model pick it on its own), and the index carries it", () => {
    const promo = listPlatformSkills().find((s) => s.id === "product-promo-video")!;
    expect(promo.description).toMatch(/^当用户.+时使用/);
    for (const cue of ["宣传片", "发布视频", "演示视频"]) expect(promo.description, cue).toContain(cue);
    const index = platformSkillIndex();
    expect(index).toContain(promo.description);
    expect(index).toContain(join(PLATFORM_SKILLS_ROOT, "product-promo-video", "SKILL.md").replace(/^\/private/, ""));
  });

  it("SKILL.md tells a model that reads it directly where SKILL_DIR is (the index path, not a replaced placeholder)", () => {
    const text = readFileSync(join(PLATFORM_SKILLS_ROOT, "product-promo-video", "SKILL.md"), "utf8");
    expect(text).toContain("本 SKILL.md 所在的目录");
    expect(text).toContain("取你读取它的路径的目录部分");
    // 定义句里不含会被平台替换掉的占位符字面量，否则展开后会变成一句不通的话
    const definition = text.split("\n").find((l) => l.includes("本 SKILL.md 所在的目录"))!;
    expect(definition).not.toContain("<SKILL_DIR>");
  });
});

describe("dispatch", () => {
  let dir: string, ws: string, mgr: RuntimeSessionManager, driver: FakeDriver;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rt-skill-")); ws = join(dir, "work"); mkdirSync(ws);
    driver = new FakeDriver("codex");
    mgr = new RuntimeSessionManager({ dataDir: join(dir, "data"), drivers: { codex: driver }, skipRecovery: true, platformSkills: {} });
    mgr.updateSettings({ workspaceRoots: [ws] }, "test"); await mgr.probe("codex");
  });
  afterEach(async () => { mgr.shutdown(); await tick(35); rmSync(dir, { recursive: true, force: true }); });

  it("first turn without /: the runtime is told which skills exist; the session still records the user's words; later turns get nothing extra", async () => {
    const user = "帮我给 Achat 做一支发布视频";
    const { session } = await mgr.create({ idempotencyKey: "index-turn-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: user, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    const first = driver.turns[0]!.args.prompt;
    expect(first.startsWith("【平台技能】")).toBe(true);
    expect(first).toContain("产品宣传视频（/产品宣传视频）：当用户想为某个产品");
    expect(first).toMatch(/说明文件：\S+product-promo-video\/SKILL\.md/);
    expect(first).not.toContain("<<<技能说明开始>>>");           // 只有目录，不是整段技能
    expect(first.endsWith(`【用户消息】\n${user}`)).toBe(true);
    const events = mgr.store.events(pid);
    expect(events.find((e) => e.key.startsWith("user:"))!.text).toBe(user);
    expect(events.some((e) => e.key.startsWith("platform-skill:"))).toBe(false);   // 目录是背景信息，不弹通知
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    await mgr.sendTurn(pid, { idempotencyKey: "index-turn-2", prompt: "再短一点", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toBe("再短一点");
  });

  it("platformSkillsExclude on create: that skill is missing from this session's first-turn index only", async () => {
    const user = "做一个落地页";
    const { session } = await mgr.create({ idempotencyKey: "index-excl-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: user, platformSkillsExclude: ["product-promo-video"], confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    await until(() => driver.turns.length === 1);
    const first = driver.turns[0]!.args.prompt;
    expect(first).not.toContain("产品宣传视频（");
    expect(first).toContain("股票账户记账（");                    // 其他技能照常列出
    expect(first.endsWith(`【用户消息】\n${user}`)).toBe(true);
    expect(mgr.store.binding(session.platformSessionId)!.platformSkillsExclude).toEqual(["product-promo-video"]);
    // 没设排除的会话不受影响
    await mgr.create({ idempotencyKey: "index-excl-2", runtimeKind: "codex", workspace: ws, title: "t2", prompt: user, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toContain("产品宣传视频（/产品宣传视频）");
  });

  it("first turn with /技能名: full expansion only, no second copy in an index", async () => {
    await mgr.create({ idempotencyKey: "index-turn-3", runtimeKind: "codex", workspace: ws, title: "t", prompt: "/产品宣传视频 做一支 30 秒的", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    await until(() => driver.turns.length === 1);
    const p = driver.turns[0]!.args.prompt;
    expect(p.match(/【平台技能：产品宣传视频】/g)).toHaveLength(1);
    // 已展开的技能不在目录里再出现一次；仓库里的其他技能（如「故障诊断修复」）仍可列在目录里
    expect(p).not.toContain("产品宣传视频（/产品宣传视频）：");
    expect(p).toContain("故障诊断修复（/故障诊断修复）：");
  });

  it("shows the user's own words even when the runtime echoes the full prompt back as the user message", async () => {
    const user = "帮我给 Achat 做一支发布视频";
    const { session } = await mgr.create({ idempotencyKey: "echo-turn-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: user, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    const sent = driver.turns[0]!.args.prompt;
    expect(sent).not.toBe(user);
    driver.turns[0]!.sink.event({ key: "codex:item:user-1", kind: "message", role: "user", text: sent, source: "stream", parserVersion: "fake", availability: "recorded" });
    await until(() => mgr.store.events(pid).some((e) => e.key === "codex:item:user-1"));
    const userTexts = mgr.store.events(pid).filter((e) => e.kind === "message" && e.role === "user").map((e) => e.text);
    expect(userTexts.length).toBeGreaterThan(0);
    for (const t of userTexts) expect(t).toBe(user);
    expect(JSON.stringify(mgr.store.events(pid))).not.toContain("【平台技能】");
  });

  it("is off unless the composition root turns it on: the prompt reaches the driver untouched", async () => {
    const plainDriver = new FakeDriver("codex");
    const plain = new RuntimeSessionManager({ dataDir: join(dir, "data2"), drivers: { codex: plainDriver }, skipRecovery: true });
    try {
      plain.updateSettings({ workspaceRoots: [ws] }, "test"); await plain.probe("codex");
      await plain.create({ idempotencyKey: "plain-turn-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: "/产品宣传视频 做一支", confirmedProfileVersion: plain.profile("codex")!.checkedAt }, "test");
      await until(() => plainDriver.turns.length === 1);
      expect(plainDriver.turns[0]!.args.prompt).toBe("/产品宣传视频 做一支");
    } finally { plain.shutdown(); await tick(35); }
  });

  it("never adds skills to automated sessions (project / role) even when enabled", async () => {
    await mgr.create({ idempotencyKey: "project-turn-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: "/产品宣传视频 做一支", projectRef: "proj-1", confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    await until(() => driver.turns.length === 1);
    expect(driver.turns[0]!.args.prompt).toBe("/产品宣传视频 做一支");
  });

  it("hands the runtime the expanded prompt but records the user's own words, on create and on follow-up turns", async () => {
    const first = "/产品宣传视频 给 Achat 做 45 秒宣传片";
    const { session } = await mgr.create({ idempotencyKey: "skill-turn-1", runtimeKind: "codex", workspace: ws, title: "t", prompt: first, confirmedProfileVersion: mgr.profile("codex")!.checkedAt }, "test");
    const pid = session.platformSessionId;
    await until(() => driver.turns.length === 1);
    // 首轮：其他技能的目录（若有）在前，展开的技能说明紧随其后，用户原文在最后
    const firstPrompt = driver.turns[0]!.args.prompt;
    expect(firstPrompt.startsWith("【平台技能】") || firstPrompt.startsWith("【平台技能：产品宣传视频】")).toBe(true);
    expect(firstPrompt.match(/【平台技能：产品宣传视频】/g)).toHaveLength(1);
    expect(driver.turns[0]!.args.prompt.endsWith(`【用户消息】\n${first}`)).toBe(true);
    const events = mgr.store.events(pid);
    expect(events.find((e) => e.key.startsWith("user:"))!.text).toBe(first);                        // 会话里仍是原文
    expect(events.find((e) => e.key === "platform-skill:1")).toMatchObject({ kind: "notice", text: "已载入平台技能：产品宣传视频" });
    driver.turns[0]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");

    // 续聊：普通消息不展开；再次调用才展开
    await mgr.sendTurn(pid, { idempotencyKey: "skill-turn-2", prompt: "把时长改成 30 秒", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 2);
    expect(driver.turns[1]!.args.prompt).toBe("把时长改成 30 秒");
    expect(mgr.store.events(pid).some((e) => e.key === "platform-skill:2")).toBe(false);
    driver.turns[1]!.finish({ status: "completed" });
    await until(() => mgr.store.binding(pid)!.status === "idle");
    await mgr.sendTurn(pid, { idempotencyKey: "skill-turn-3", prompt: "/product-promo-video 再来一版竖屏", expectedRevision: mgr.store.binding(pid)!.bindingRevision }, "test");
    await until(() => driver.turns.length === 3);
    expect(driver.turns[2]!.args.prompt).toContain("【平台技能：产品宣传视频】");
    expect(driver.turns[2]!.args.prompt.endsWith("【用户消息】\n/product-promo-video 再来一版竖屏")).toBe(true);
  });
});
