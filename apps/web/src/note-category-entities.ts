/**
 * 待办分类的实体词表（note-entities@1）。
 *
 * 为什么要有它：模型原来只能从 5 个写死的「XX-开发」和已有分类里挑，平台真正的产品——
 * 产物里的小游戏（算术宠物进化岛、心愿挑战岛、错题本、句子侦探社）——从来不在候选里，
 * 于是「错题本拍照」只能被塞进「作品/教育」这种兜底大类，「打卡任务的每日惩罚」被塞进
 * 「笔记待办日历/待办」。用户说「小游戏相关的东西打不中」，根因就是词表缺了这些实体。
 *
 * 单一来源：产品名 / 概览 / 标签只从 artifact-products.ts 取——新增一个产物在那边
 * 登记一次（artifacts.ts 也从同一份数据取），这里自动带上，不用改提示词。这里不 import
 * artifacts.ts：独立版会把它整份换成空目录桩，分类器不该依赖产物库实现。本文件只补三样推不出来的信息：
 * 用户口语里的别名、正文判定词（只收专指词，不收「页面」「按钮」）、该实体已经做过的功能模块。
 *
 * 这些值都是**候选与提示**，不是校验白名单的反面：模型仍要按正文判断，拿不准就给多个候选并
 * 标 uncertain；确需新模块时照旧要写 newModuleReason。
 */
import { ARTIFACT_PRODUCTS } from "./artifact-products.js";

/** 词表版本：改词条内容就升。它独立于提示词版本，用于回溯评测与「只重打受影响的记录」。 */
export const NOTE_ENTITY_LEXICON = "note-entities@1";

/** 「小游戏」是一组产品，不是一级分类：正文只说小游戏时，要按内容判断是哪一个。 */
export const NOTE_ENTITY_GROUP = { name: "小游戏", aliases: ["小游戏", "游戏", "产物里的小游戏"] };

export interface NoteCategoryEntity {
  /** 一级候选：产品名 / 应用名 / 项目名 */
  name: string;
  /** 用户口语里的同义叫法（「挑战岛」「错题」…） */
  aliases: string[];
  /** 正文判定词：出现这些词时应当优先归属该实体 */
  hints: string[];
  /** 该实体已经做过的功能模块（二级候选）；为空表示需要模型提出并说明理由 */
  modules: string[];
  kind: "product" | "app" | "project" | "category";
}

/** 产品级词条：名称来自 artifacts.ts，这三样维护在这里。 */
const PRODUCT_LEXICON: Record<string, { aliases: string[]; hints: string[]; modules: string[] }> = {
  "pet-math-game": {
    aliases: ["宠物进化岛", "宠物小游戏", "口算小游戏", "算术小游戏", "养小马"],
    hints: ["口算", "进化", "喂养", "喂食", "小马"],
    modules: ["口算关卡", "喂养与进化", "双人对战", "声音与动画"],
  },
  "challenge-island": {
    aliases: ["挑战岛", "挑战目标", "挑战任务", "打卡小游戏", "心愿岛"],
    hints: ["打卡", "补打卡", "星星", "心愿", "兑换", "每日惩罚", "周目标", "每周目标"],
    modules: ["挑战目标", "打卡", "每日惩罚", "心愿兑换", "日历与统计", "家庭分享"],
  },
  "wrong-book": {
    aliases: ["错题", "错题整理", "错题练习"],
    hints: ["错题", "拍照录入", "识图", "题型确认", "每周测验", "讲解"],
    modules: ["拍照录入", "识图与题型确认", "错题本", "每周测验", "讲解", "设置"],
  },
  "word-detective": {
    aliases: ["侦探社", "句子侦探", "英语小游戏"],
    hints: ["主语", "动词", "宾语", "疑问句", "侦探猫"],
    modules: ["关卡与规则", "答题反馈"],
  },
  "ring-toss": {
    aliases: ["套圈", "套圈小游戏", "夜市套圈"],
    hints: ["套圈", "奖品", "震动触感", "物理碰撞", "辅助瞄准"],
    modules: ["选圈与奖品", "物理投掷", "震动触感", "兑奖结算"],
  },
};

/** 平台应用级词条：只给已有的一级分类补别名与判定词，不新造实体。 */
const APP_LEXICON: Record<string, { aliases: string[]; hints: string[]; modules: string[] }> = {
  "会话": {
    aliases: ["对话", "聊天", "runtime 会话"],
    hints: ["会话", "对话", "输入框", "消息", "归档", "未读", "轮次"],
    modules: ["列表页", "新建页", "详情页", "输入框", "消息", "关联", "文件预览", "推荐快捷回复"],
  },
  "笔记待办日历": {
    aliases: ["待办", "笔记", "日历", "备忘录"],
    hints: ["待办", "笔记", "日程", "日历", "分类", "提醒", "清单"],
    modules: ["创建", "列表", "待办", "笔记", "日历", "分类", "关联"],
  },
  "平台": {
    aliases: ["系统", "PWA", "原生壳", "设置"],
    hints: ["部署", "上线", "通知", "导航", "权限", "沙盒", "网络", "缓存"],
    modules: ["界面框架", "通知", "网络", "工具与权限", "分享", "部署", "debug"],
  },
  "资源": {
    aliases: ["余额", "订阅", "额度", "套餐"],
    hints: ["余额", "订阅", "额度", "套餐"],
    modules: ["账户资源"],
  },
};

/** 这些标签太泛（每个教育类产品都有），当判定词只会互相干扰。 */
const GENERIC_TAGS = new Set(["三年级", "小学", "可离线", "拍照", "积分"]);

/**
 * 生成本次分类用的实体词表：
 * 已有的一级分类（保序，模型沿用现有目录）+ 产物清单里的产品 + 真实项目。
 * 同名实体只留一条（已有分类优先），避免同一级出现两个同义名字。
 */
export function noteCategoryEntities(primaryNames: readonly string[], projectNames: readonly string[] = []): NoteCategoryEntity[] {
  const out: NoteCategoryEntity[] = [];
  const seen = new Set<string>();
  const push = (entity: NoteCategoryEntity) => {
    const name = entity.name.trim().normalize("NFC");
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push({ ...entity, name, aliases: unique(entity.aliases.filter(a => a && a !== name)), hints: unique(entity.hints.filter(Boolean)), modules: unique(entity.modules.filter(Boolean)) });
  };
  // 已有的一级分类：保持原顺序，模型继续沿用现有目录。
  for (const name of primaryNames) {
    const key = name.trim().normalize("NFC");
    const known = APP_LEXICON[key];
    push({ name: key, aliases: known?.aliases ?? [], hints: known?.hints ?? [], modules: known?.modules ?? [], kind: "category" });
  }
  for (const product of ARTIFACT_PRODUCTS) {
    const known = PRODUCT_LEXICON[product.id];
    const tags = product.tags.filter(tag => !GENERIC_TAGS.has(tag));
    push({
      name: product.name,
      aliases: [...(known?.aliases ?? []), ...tags],
      hints: [...(known?.hints ?? []), ...tags],
      modules: known?.modules ?? [],
      kind: "product",
    });
  }
  for (const name of projectNames) {
    const key = name.trim().normalize("NFC");
    if (!key) continue;
    const known = APP_LEXICON[key];
    push({ name: key, aliases: known?.aliases ?? [], hints: known?.hints ?? [], modules: known?.modules ?? [], kind: "project" });
  }
  return out;
}

/** 「小游戏」这组现在有哪些产品（产品被摘掉时自动缩水）。 */
export function noteEntityGroup(entities: readonly NoteCategoryEntity[]): { name: string; aliases: string[]; products: string[] } {
  const products = entities.filter(e => e.kind === "product").map(e => e.name);
  return { ...NOTE_ENTITY_GROUP, aliases: [...NOTE_ENTITY_GROUP.aliases], products };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
