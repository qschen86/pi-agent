/**
 * 产物清单里「分类器需要的那一半」：id / 分类 / 名称 / 概览 / 标签。
 *
 * 单独成文件是因为独立版（Homebrew）把 artifacts.ts 整份换成空目录桩（build-homebrew-payload 的
 * core-edition 插件），而待办分类的实体词表只需要这份纯数据。放在这里以后：
 *   - 新增一个产物只在 artifacts.ts 登记（名称/标签从本文件取，单一来源，不会两边漂移）；
 *   - 独立版不需要为了分类器保留产物库实现，也不会因为桩里少一个导出就整包构建失败。
 *
 * 这里只放纯数据：不带路径、不读文件系统、不 import 任何运行时模块。
 */
export interface ArtifactProduct {
  id: string;
  category: string;
  name: string;
  summary: string;
  tags: string[];
}

export const ARTIFACT_PRODUCTS: ArtifactProduct[] = [
  {
    id: "pet-math-game",
    category: "games",
    name: "算术宠物进化岛",
    summary: "三年级口算 × 小马宝莉养成",
    tags: ["口算", "三年级", "宠物养成", "双人对战", "可离线"],
  },
  {
    id: "challenge-island",
    category: "games",
    name: "心愿挑战岛",
    summary: "每天 / 每周目标 · 拍照打卡攒星星换心愿",
    tags: ["打卡", "三年级", "积分", "心愿", "拍照", "可离线"],
  },
  {
    id: "wrong-book",
    category: "games",
    name: "错题本",
    summary: "拍照录入错题 · 每周专属测验 · 小朋友听得懂的讲解",
    tags: ["错题", "三年级", "上海数学", "拍照", "每周测验", "讲解动画"],
  },
  {
    id: "word-detective",
    category: "games",
    name: "句子侦探社",
    summary: "三年级英语：主语动词宾语 × 变疑问句",
    tags: ["英语", "三年级", "语法", "可离线"],
  },
  {
    id: "ring-toss",
    category: "games",
    name: "夜市套圈摊",
    summary: "自选圈数与奖品 · 手指上滑控力道旋转 · 真实物理与震动触感",
    tags: ["套圈", "物理互动", "震动触感", "兑奖", "可离线"],
  },
];
