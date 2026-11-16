/**
 * 项目记忆的「功能模块」维度（docs/requirements/v3.105-public-memory-modules）：模块 + 跨模块。
 * 模块名与用户看到的一级导航应用名对齐（apps/web/public/index.html 的 #primary-navigation）。
 *
 * 为什么要它：项目记忆原来的子类（约定红线｜架构边界｜方法）是按条目性质分的，agent 查记忆时
 * 没法按「我现在在改哪个功能」去捞；v3.107 起项目记忆不再有性质这一维，**模块就是分类**。
 * 排在最前的「目标」不挂在某个功能上：它记的是项目要往哪走、优先级与取舍，用来判断新需求是否符合大目标。
 *
 * 约定：
 * - id 稳定（英文，进数据与索引），name 是给人和 agent 看的中文名；改名只改 name / aliases，不改 id。
 * - aliases 同时供三处用：模型归类时的候选叫法、索引里 `#模块` 的 grep 关键词、搜索接口的命中词。
 * - requirementPrefixes 是 docs/requirements 目录名（去掉版本号后，小写）的前缀，只作归类提示与存量回填初判，
 *   不参与「合法性」校验：模型给出清单外的值一律按 CROSS_MODULE 处理。
 * - 跟哪个功能都不绑的项目记忆落 CROSS_MODULE（页面叫「待归类」）。
 */
export const CROSS_MODULE = 'cross';

export interface ModuleDef {
  /** 稳定 id（英文小写，进 topic.module / 索引 / 接口） */
  id: string;
  /** 中文名（索引与页面显示） */
  name: string;
  /** 别名与关键词（grep 用；模型归类时的候选叫法） */
  aliases: readonly string[];
  /** 这个模块对产品的目标，一句话：归类时用来判断「这句话是不是在说这个模块」 */
  goal: string;
  /** 文本里的判定词（存量回填 / 人工排查用）：只收比较专指的词，别把「页面」「按钮」这种到处都有的词放进来 */
  hints: readonly string[];
  /** docs/requirements 目录名前缀（原文小写，含连字符），仅作归类提示 */
  requirementPrefixes: readonly string[];
}

export const PROJECT_MODULES: readonly ModuleDef[] = [
  {
    id: 'goal', name: '目标',
    aliases: ['目标', '大目标', '大方向', '方向', '优先级', '取舍', '愿景', '产品目标'],
    goal: '项目要往哪走：做到什么、先做哪一类、取舍与优先级；用来判断新需求是否符合大目标，不记进展与完成情况',
    hints: ['目标', '大目标', '大方向', '优先做', '取舍', '先做'],
    requirementPrefixes: []
  },
  {
    id: 'session', name: '会话',
    aliases: ['会话', '对话', '对话应用', '聊天', '输入框', '消息', '房间', 'runtime 会话'],
    goal: '把平台会话/房间的发起、续聊、消息与输入体验做顺：发起、归档、未读、快捷回复、附件入口',
    hints: ['会话', '对话', '输入框', '消息', '房间', '归档', '未读', '快捷回复'],
    requirementPrefixes: ['session', 'room', 'agent-room', 'new-session', 'runtime-chat', 'composer', 'quick-reply', 'unread', 'runtime-comparison', 'entry-origin', 'preferred-entry-origin', 'authorization', 'adopt-existing-child']
  },
  {
    id: 'ui', name: '界面',
    aliases: ['界面', '导航', '顶栏', '底栏', 'tab', '主题', '动效', '滑动', '骨架屏', '浮层', '交互', 'UI', '手机端', '手机', 'mobile', 'PWA', '原生壳', 'APK', 'Android', 'iOS', '小组件', '启动器', '键盘遮挡'],
    goal: '全平台界面与交互的统一规范（含手机端）：导航与 tab、过渡动效、主题、层级、对齐与占位；手机端的 PWA 壳与更新、原生 WebView、软键盘、系统栏、桌面小组件与启动器角标',
    hints: ['导航', '顶栏', '底栏', 'tab 切换', '过渡动画', '动效', '骨架屏', '浮层', '对齐', '层级', '手机', 'PWA', '原生壳', 'APK', 'Android', 'iOS', '小组件', '启动器', '软键盘', '系统栏', '角标'],
    requirementPrefixes: ['ui-consistency', 'webui', 'unified-page', 'unified-inpage', 'flat-inpage', 'inpage', 'navigation', 'nav', 'liquid-glass', 'toast', 'header', 'tab', 'swipe', 'skeleton', 'phone-nav', 'desktop-glass', 'longpress', 'long-press', 'overlay', 'sidebar', 'fab-', 'bubble-nav', 'status-bar', 'resource-card-swipe', 'pwa', 'android', 'ios', 'widget', 'launcher', 'vivo', 'native', 'keyboard', 'mobile-', 'orientation', 'install', 'lan-', 'apk-update']
  },
  {
    id: 'settings', name: '设置',
    aliases: ['设置', '设置页', '账号', '登录', '开关', '能力入口', '偏好设置'],
    goal: '设置页本身：入口与导航、账号与登录、开关与能力入口、提示与横幅的统一',
    hints: ['设置页', '设置', '开关', '账号', '登录', '能力入口'],
    requirementPrefixes: ['settings', 'login-', 'capability', 'sticky-capability', 'runtime-tips', 'remove-runtime-tips']
  },
  {
    id: 'deploy', name: '部署与发布',
    aliases: ['部署', '上线', '发布', 'APK 发布', '空闲部署', '测试闸门', '夜间回归'],
    goal: '把改动安全地送上线上：空闲部署排队、测试闸门、版本资源、夜间回归与发布记录',
    hints: ['部署', '上线', '发布', '空闲', '测试闸门', '夜间回归', '回滚', '提交部署'],
    requirementPrefixes: ['deploy', 'release', 'apk', 'test-gate', 'test-', 'nightly', 'regression', 'baseline', 'session-deploy']
  },
  {
    id: 'memory', name: '记忆',
    aliases: ['记忆', '公共记忆', '平台记忆', '私有记忆', 'runtime 记忆', '入库', '注入', '记忆分类'],
    goal: '平台公共记忆的采集、归类、注入与浏览；与 runtime 私有记忆的边界',
    hints: ['记忆', '注入', '索引', '提炼', '归类', '常驻', '按需'],
    requirementPrefixes: ['memory', 'public-memory', 'platform-memory', 'platform-injection', 'runtime-memory']
  },
  {
    id: 'rec', name: '推荐',
    aliases: ['推荐', '推荐任务', '候选池', '推荐评分', '推荐选项'],
    goal: '按待办聚合与优先级生成推荐任务，并在会话输入框给出推荐选项',
    hints: ['推荐任务', '推荐', '候选池', '评分'],
    requirementPrefixes: ['notes-recommended', 'recommend', 'rec-', 'pinned-rec']
  },
  {
    id: 'plan', name: '待办',
    aliases: ['待办', '笔记', '日程', '日历', '定时任务', '提醒', '重复日程', 'Today'],
    goal: '笔记/待办/日程一体：分类、检索、日程与重复、定时任务、今日卡片',
    hints: ['待办', '笔记', '日程', '日历', '定时任务', '重复日程', '今日'],
    requirementPrefixes: ['notes', 'note-', 'kind-', 'linked-note', 'todo', 'calendar', 'google-calendar', 'scheduled', 'schedule-module', 'today-cards', 'recurring', 'agent-scheduled', 'platform-scheduled', 'entry-relations']
  },
  {
    id: 'resources', name: '资源',
    aliases: ['资源', '模型', '统计', '用量', '额度', '额度用量', '主机状态', '埋点', '计数', 'token 统计', '模型选择', 'runtime 配置', 'DeepSeek', '峰谷', '推理档位', 'model', 'stats'],
    goal: '「资源」应用：外部资源与模型表、模型选择与档位、额度与峰谷、用量消耗统计、主机状态与埋点',
    hints: ['模型', '额度', '用量', 'token', '主机状态', '埋点', '峰谷', 'DeepSeek'],
    requirementPrefixes: ['usage', 'stats', 'statistics', 'telemetry', 'host-stats', 'host-status', 'pc-host-status', 'token', 'count', 'model', 'runtime-config', 'deepseek', 'quota', 'agent-model', 'config']
  },
  {
    id: 'comm', name: '通讯录',
    aliases: ['通讯录', '通讯', '联系人', '消息通信', '本地鉴权'],
    goal: '平台内的通讯能力：联系人、会话容量、本地鉴权与消息同步',
    hints: ['通讯录', '联系人', '通话', '短信', '通讯'],
    requirementPrefixes: ['communications', 'contacts', 'comm']
  },
  {
    id: 'game', name: '小游戏',
    aliases: ['小游戏', '挑战', '游戏', '关卡', '对战', '识字', '关卡难度', '碎片'],
    goal: '给小朋友的挑战/游戏：关卡与难度、字体与展示、结算奖励与碎片进度',
    hints: ['关卡', '挑战', '游戏', '小朋友', '小孩', '碎片', '结算', '识字', '对战'],
    requirementPrefixes: ['challenge', 'math', 'game', 'checkin', 'battle-']
  },
  {
    id: 'ledger', name: '股票',
    aliases: ['股票', '台账', '账单', '账户', '资产', '负债', '入金', '市值'],
    goal: '股票账户台账：账户占比、动账记录、账单窗口与筛选',
    hints: ['台账', '股票', '账户', '动账', '入金', '出金', '账单', '负债', '资产', '市值'],
    requirementPrefixes: ['stock-ledger', 'ledger', 'liability', 'bill', 'account']
  },
  {
    id: 'webx', name: 'AI浏览器',
    aliases: ['AI浏览器', 'web-X', '网络', '网页研究', '浏览器', 'H5 容器', '上下文采集', '阅读模式', '代理', 'v2ray'],
    goal: 'H5 服务容器与上下文采集：站点坞、三种采集方式、内置阅读与外观、代理与网络健康',
    hints: ['AI浏览器', 'web-X', '网页', '浏览器', '采集', '阅读模式', '代理'],
    requirementPrefixes: ['web-x', 'web-research', 'research', 'v2ray', 'proxy']
  },
  {
    id: 'media', name: '图片与文件',
    aliases: ['图片', '文件', '附件', '相册', '截图', '剪贴板', '预览', '产物', '产物分享'],
    goal: '图片/文件/产物的采集、压缩、气泡手势、全屏预览与分享',
    hints: ['图片', '文件', '附件', '相册', '截图', '剪贴板', '预览', '产物', '压缩'],
    requirementPrefixes: ['image', 'file', 'artifact', 'eval-artifacts', 'upload', 'preview', 'diagram', 'video', 'album', 'photo', 'clipboard', 'screenshot', 'share', 'page-share', 'recent-photo', 'mobile-image', 'message-diagram']
  }
];

const BY_ID = new Map(PROJECT_MODULES.map(m => [m.id, m]));
const ALIAS = new Map<string, string>();
for (const m of PROJECT_MODULES) {
  for (const k of [m.id, m.name, ...m.aliases]) ALIAS.set(k.toLowerCase(), m.id);
}

/** 已并入别的模块的旧 id：存量数据里还可能带着，读取时统一改写（store.ts），解析时也认。 */
export const RETIRED_MODULES: Readonly<Record<string, string>> = { mobile: 'ui' };
export const currentModule = (id: string | undefined): string | undefined => (id && RETIRED_MODULES[id]) || id;

export const moduleIds = (): string[] => [CROSS_MODULE, ...PROJECT_MODULES.map(m => m.id)];
export const moduleById = (id: string): ModuleDef | undefined => BY_ID.get(id);
/** 模块显示名：cross → 跨模块；未知 id 原样返回（兼容旧数据） */
export const moduleName = (id: string | null | undefined): string =>
  !id || id === CROSS_MODULE ? '跨模块' : (BY_ID.get(id)?.name ?? id);
/**
 * 把模型输出 / 存量数据里的模块写法归一成 id：id、中文名、别名都认；
 * 认不出的一律当跨模块——宁可不归类，也不给一个假模块。
 */
export function resolveModule(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return CROSS_MODULE;
  const hit = ALIAS.get(s.toLowerCase());
  if (hit) return hit;
  // 允许模型写成「会话与对话应用里的…」这类带后缀的说法
  for (const [k, id] of ALIAS) if (k.length >= 2 && s.includes(k)) return id;
  return CROSS_MODULE;
}
/** 目录名（已去版本号、小写）→ 模块 id；只作存量回填初判，认不出返回 null。 */
export function moduleOfRequirement(name: string): string | null {
  const s = name.trim().toLowerCase();
  const hit = PROJECT_MODULES.find(m => m.requirementPrefixes.some(p => s.startsWith(p)));
  return hit?.id ?? null;
}
/** 给模型看的模块清单（id 与中文名成对，保证它只从清单里选）。 */export const modulesForPrompt = (): string =>
  PROJECT_MODULES.map(m => `${m.id}（${m.name}：${m.goal}）`).join('\n') + `\n${CROSS_MODULE}（跨模块：换到哪个模块都成立、也不属于项目目标的记忆）`;

/** 「目标」模块：项目的大方向，不挂在具体功能上，注入时单独一桶。 */
export const GOAL_MODULE = 'goal';
export const isGoalModule = (id: string | null | undefined): boolean => id === GOAL_MODULE;

/**
 * 索引 / 搜索里的严格模块匹配：只有整串就写成 id / 中文名 / 别名（可带 #）才算某个模块。
 * 和 resolveModule 的区别：不做“包含”回退，所以普通关键词不会被误判成模块（认不出返回 null）。
 */
export function moduleFromQuery(raw: string): string | null {
  const s = raw.trim().replace(/^#/, '').trim().toLowerCase();
  if (!s) return null;
  if (s === CROSS_MODULE || s === '跨模块' || s === '待归类') return CROSS_MODULE;
  return ALIAS.get(s) ?? null;
}
