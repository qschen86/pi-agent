// 应用清单：对外发布的唯一分类依据（需求 v3.123）。
// 档位：core 基础 / optional 可选 / private 私有。公开构建、运行时路由屏蔽、前端资源裁剪都只读这里，
// 不再各自维护黑名单。新增路由、前端模块、静态资源或数据目录时必须先在此归属，否则 app-manifest.test.ts 会失败。
//
// 字段：
//   api          /api/<名> 前缀（匹配 `/api/<名>` 与其子路径）
//   pages        非 /api 的服务端路径前缀
//   views        index.html 里 data-view 的底栏按钮
//   routeModules index.html <template id="route-modules"> 里的 data-route-module
//   assets       apps/web/public 顶层的 .js / .css 文件
//   sources      apps/web/src 下的源文件（* 通配），公开构建里被排除的应用在这里被替换成空桩
//   data         ~/.pi-agent-gui/data 下归属该应用的文件或目录；目录以 / 结尾（首次启动时按发布版本建出空骨架），文件由各 store 按需创建。
//                数据一律私有（见 DATA_CLASSES），路径只能经 app-data.ts 的 AppData 取得
//   dataReads    读取其他应用数据的登记，格式 `<应用id>:<名字>`（只读；对方没有这份数据时视为空）
//   switchable   可选应用才有：用户能在设置里启用 / 关闭（基础应用始终开启，私有应用不在设置里出现）
//   description  设置里「应用」页展示的一句话说明（switchable 必填）
//   artifacts    该应用对应的产物（/games/<id>）：应用关闭时产物目录里不再列出、也打不开
//   requires     依赖的其他应用 id（硬依赖：对方不发布，本应用就不能发布）
//   softRequires 可选增强的其他应用 id（对方不发布时本应用照常工作，只是少一块功能）
//   debt         已知的违反分层依赖（基础依赖了可选 / 私有），必须写明原因；清零前不得删除对应 requires

export const TIERS = ['core', 'optional', 'private'];

/** 数据分两类：default 随发布带（空骨架、出厂模板、通用文档）；private 用户实例产生，永不进发布包。 */
export const DATA_CLASSES = ['default', 'private'];

export const APPS = [
  // ───────── 基础 ─────────
  {
    id: 'runtime-sessions', name: '会话与运行时', tier: 'core',
    api: ['runtime-sessions', 'runtime-profiles', 'runtime-comparisons', 'runtime', 'runtime-settings', 'runtime-auth', 'runtime-attachments',
      'runtime-attachment-diagnostics', 'runtime-submissions', 'runtime-scheduled-messages', 'runtime-usage', 'session-directory',
      'session-sync', 'stream', 'pick-folder', 'image-intake', 'launch-timing', 'client-events', 'host', 'runtime-updates'],
    pages: [],
    views: ['rt'],
    routeModules: ['rt-list', 'rt-transcript', 'rt-detail', 'rt-compare', 'rt-new', 'runtimes'],
    assets: ['runtime.js', 'runtime-attachments.js', 'runtime-chat.js', 'runtime-compare.js', 'runtime-compare-page.js', 'runtime-detail.js',
      'runtime-directory.js', 'runtime-new.js', 'runtime-settings.js', 'runtime-transcript.js', 'host-stats.js', 'session-drawer.js', 'session-island.js'],
    sources: [], data: ['runtime/', 'session-sync/', 'runtime-updates/', 'provider-calls.jsonl'],
    softRequires: ['notes'] // rt-list 在带了笔记的构建里嵌「今日待办」卡片与上滑进待办；没带时自动省略（index.html 里是 data-route-soft-dependencies）
  },
  {
    id: 'rooms', name: '群聊', tier: 'core',
    api: ['rooms'], pages: [], views: [], routeModules: ['room'], assets: ['room.js', 'room-page.js'],
    sources: [], data: [] // 房间数据在 runtime/rooms.json，归 runtime-sessions
  },
  {
    id: 'memory', name: '记忆', tier: 'core',
    api: ['memory'], pages: [], views: ['memory'], routeModules: ['memory', 'memory-architecture'],
    assets: ['memory-public.js', 'memory-architecture.js'], sources: [],
    data: ['memory/', 'memory-public/', 'memory-native/', 'memory-browse/', 'memory-titles/', 'memory-replay/'],
    dataReads: ['runtime-sessions:runtime', 'android:android-release']
  },
  {
    id: 'auth', name: '登录与设备配对', tier: 'core',
    api: ['auth', 'remote-connect'], pages: ['/device-pair', '/login'], views: [], routeModules: [], assets: [], sources: [],
    data: ['auth-sessions.json', 'auth-sessions.json.mutex.sqlite', 'auth-sessions.json.pairs.json', 'auth-sessions.json.pairs.json.mutex.sqlite', 'device-pairs.json', 'remote-connect.json', 'remote-connect.json.mutex.sqlite']
  },
  {
    id: 'notifications', name: '通知', tier: 'core',
    api: ['notifications'], pages: [], views: [], routeModules: [], assets: ['notifications.js'], sources: [],
    data: ['notifications/', 'read-state.json']
  },
  {
    id: 'shell', name: '设置、导航与缓存（PWA）', tier: 'core',
    api: ['navigation', 'apps', 'platform', 'platform-skills', 'web-release'], pages: ['/share-target'], views: [],
    routeModules: ['settings', 'version-share', 'share-image-renderer'],
    assets: ['app.js', 'app-swipe.js', 'route-loader.js', 'navigation.js', 'nav-settings.js', 'settings.js', 'pwa.js', 'sw.js', 'theme.js',
      'splash.js', 'splash.css', 'toast.js', 'keyboard.js', 'orientation.js', 'overlay-history.js', 'seg-indicator.js', 'telemetry.js',
      'local-first.js', 'session-persistence.js', 'session-sync.js', 'version-share.js', 'share-image-renderer.js', 'styles.css'],
    sources: [], data: ['navigation.json', 'app-switches.json', 'platform-skills.json', 'runtime-billing.json', 'fx-rates.json', 'ui-refinement/']
  },
  {
    id: 'resources', name: '外部资源与用量', tier: 'core',
    api: ['resources', 'stats'], pages: [], views: ['resources'], routeModules: ['resources', 'stats'],
    assets: ['resources.js', 'stats.js'], sources: [],
    data: ['resource-balances.json', 'web-research-provider.json', 'deepseek-usage.jsonl', 'deepseek-usage.jsonl.legacy-imported'],
    dataReads: ['runtime-sessions:runtime', 'notes:note-categories.json', 'notes:note-iterations.json', 'shell:runtime-billing.json', 'shell:fx-rates.json']
  },
  {
    id: 'message-tools', name: '消息增强（图片、链接、文件、图表）', tier: 'core',
    api: ['link-preview', 'diagrams'], pages: [], views: [], routeModules: [],
    assets: ['clipboard-history.js', 'clipboard-images.js', 'diagram-preview.js', 'file-chips.js', 'image-intake.js', 'image-intake-bubble.js',
      'image-intake-store.js', 'image-zoom.js', 'logos.js'],
    sources: [], data: []
  },
  {
    id: 'deploy-ops', name: '部署队列、诊断与错误统计', tier: 'core',
    api: ['diagnostics', 'error-stats', 'verify'], pages: [], views: [], routeModules: [], assets: [], sources: [],
    data: ['diagnostics/', 'repair-backups', 'v34-repair-backups'],
    dataReads: ['runtime-sessions:runtime']
  },
  {
    id: 'runtime-extras', name: '运行时管理扩展（Codex 重置提醒、评测产物）', tier: 'core',
    api: ['codex-resets', 'eval-artifacts'], pages: ['/evals'], views: [], routeModules: [], assets: ['artifacts-eval.js'], sources: [],
    data: ['codex-reset/', 'eval-artifacts/']
  },
  {
    id: 'artifacts', name: '产物', tier: 'core',
    api: ['artifacts', 'artifact-collections'], pages: ['/artifacts'], views: ['artifacts'], routeModules: [],
    assets: ['artifacts.js', 'artifact-collections.js'], sources: [],
    data: ['artifact-collections.json', 'artifact-images/']
  },
  {
    id: 'artifact-shares', name: '产物分享链接', tier: 'core',
    api: ['artifact-shares'], pages: ['/share'], views: [], routeModules: [], assets: [],
    sources: [], data: ['artifact-shares.json'],
    softRequires: ['challenge'] // 心愿挑战岛通过 ShareExtension（challenge-share.ts）挂到分享页；没带时分享页照常工作
  },

  // ───────── 可选 ─────────
  {
    id: 'notes', name: '笔记、待办与日程', tier: 'optional', switchable: true,
    description: '记笔记、待办和日程，含日历与推荐任务。关闭后入口和相关功能隐藏，已有数据保留。',
    api: ['notes', 'note-categories', 'note-iterations', 'note-relations'], pages: [], views: ['notes'],
    routeModules: ['notes', 'note-relations', 'note-relation-graph'],
    assets: ['notes.js', 'notes-shared.js', 'note-relations.js', 'note-relation-graph.js'], sources: [],
    data: ['notes.json', 'note-categories.json', 'note-categories.json.before-event-topic-v1.bak', 'note-iterations.json', 'note-iterations-runs.jsonl', 'notes-images/']
  },
  {
    id: 'calendar', name: '日程', tier: 'optional', // 界面嵌在笔记里，随「笔记、待办与日程」开关一起开关，不单独出现在设置里
    api: ['calendar', 'google-calendar'], pages: [], views: [], routeModules: [], assets: [], sources: [],
    data: ['google-calendar.json'], requires: ['notes']
  },
  {
    id: 'games', name: '单词侦探', tier: 'optional', switchable: true,
    description: '三年级英语句子侦探社：找出句子里的主语、动词、宾语，再把陈述句变疑问句。关闭后产物里不再列出，已有进度保留。',
    artifacts: ['word-detective'],
    api: [], pages: ['/games'], views: [], routeModules: [], assets: [],
    sources: [], data: [] // 进度存在浏览器本地，全部私有
  },
  {
    id: 'challenge', name: '心愿挑战岛', tier: 'optional', switchable: true,
    description: '每天、每周的目标打卡，拍照攒星星换心愿。关闭后产物里不再列出，已有记录保留。',
    artifacts: ['challenge-island'],
    api: ['challenge'], pages: [], views: [], routeModules: [], assets: [],
    sources: ['challenge-*'], data: ['challenge/']
  },
  {
    id: 'wrong-book', name: '错题本', tier: 'optional', switchable: true,
    description: '拍照录入错题、每周出题验题、讲解动画。关闭后产物里不再列出，每周自动出题也会停止，已有题目保留。',
    artifacts: ['wrong-book'],
    api: ['wrong-book'], pages: [], views: [], routeModules: [], assets: [],
    sources: ['wrong-book-*'], data: ['wrong-book/']
  },
  {
    id: 'ring-toss', name: '夜市套圈摊', tier: 'optional', switchable: true,
    description: '自选圈数与奖品的真实物理套圈小游戏，支持原生与网页震动触感。关闭后产物里不再列出，已有奖品清单保留。',
    artifacts: ['ring-toss'],
    api: [], pages: [], views: [], routeModules: [], assets: [],
    sources: [], data: []
  },
  {
    id: 'android', name: 'Android 客户端', tier: 'optional', switchable: true,
    description: 'Android 客户端的更新分发和原生推送通知。关闭后手机端收不到原生推送、也不能从这里更新，网页版不受影响。',
    api: ['android', 'native-notifications'], pages: [], views: [], routeModules: [],
    assets: ['android-shell.js', 'native-update.js', 'recent-photos.js'], sources: [],
    data: ['android-release/', 'android-release-candidates/', 'android-signing/', 'android-firebase/', 'native-notifications/']
  },
  {
    id: 'lan', name: '局域网直连', tier: 'optional', switchable: true,
    description: '手机在同一个局域网时直连这台电脑，更快也不走公网。关闭后不再监听局域网端口，手机只能走公网入口。',
    api: ['lan'], pages: [], views: [], routeModules: [], assets: [], sources: ['lan-*'], data: ['lan-probe.json']
  },
];

/**
 * 各发布版本的取舍。private 在任何版本里都不发布。
 * optional：该版本带上的可选应用；holdback：本该发布、但还有未解的耦合而暂缓的应用（写明原因，清零为目标）；
 * hideViews：本版本隐藏的底栏按钮。
 */
export const EDITIONS = {
  homebrew: {
    optional: ['notes', 'calendar'],
    holdback: {},
    hideViews: ['resources']
  }
};

export function appById(id, apps = APPS) { return apps.find(app => app.id === id); }

/** 该版本发布的应用。 */
export function shippedApps(edition, apps = APPS) {
  const rule = EDITIONS[edition];
  if (!rule) throw new Error(`未知发布版本：${edition}`);
  return apps.filter(app => app.tier === 'core' ? !(app.id in rule.holdback)
    : app.tier === 'optional' ? rule.optional.includes(app.id) && !(app.id in rule.holdback) : false);
}

/** 该版本不发布的应用。 */
export function omittedApps(edition, apps = APPS) {
  const shipped = new Set(shippedApps(edition, apps).map(app => app.id));
  return apps.filter(app => !shipped.has(app.id));
}

/** 数据条目的名字：去掉目录的尾斜杠。 */
export const dataName = entry => entry.replace(/\/+$/, '');
/** 数据条目是否为目录（以 / 结尾）。 */
export const isDataDir = entry => entry.endsWith('/');

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glob = text => text.split('*').map(escape).join('[^/\\\\]*');
const alt = items => items.map(escape).join('|');
const never = /(?!)/;

/** 运行时请求路径里不发布的部分（给 core-web 返回 404）。 */
export function omittedPathPattern(edition, apps = APPS) {
  const omitted = omittedApps(edition, apps);
  const api = omitted.flatMap(app => app.api), pages = omitted.flatMap(app => app.pages);
  const parts = [];
  if (api.length) parts.push(`api/(?:${alt(api)})(?:/|$)`);
  // 页面前缀：保留已发布应用里更具体的路径（如 /artifacts/collections 属产物集合，仍要发布）
  for (const page of pages) parts.push(`${escape(page.replace(/^\//, ''))}(?:/|$)`);
  return parts.length ? new RegExp(`^/(?:${parts.join('|')})`) : never;
}

/** 构建时用空桩替换的源文件（匹配绝对路径）。 */
export function omittedSourcePattern(edition, apps = APPS) {
  const names = omittedApps(edition, apps).flatMap(app => app.sources);
  return names.length ? new RegExp(`[/\\\\]apps[/\\\\]web[/\\\\]src[/\\\\](?:${names.map(glob).join('|')})\\.ts$`) : never;
}

/** public 目录顶层不进发布包的静态资源（匹配相对路径）。 */
export function omittedAssetPattern(edition, apps = APPS) {
  const files = omittedApps(edition, apps).flatMap(app => app.assets);
  return files.length ? new RegExp(`^(?:${alt(files)})$`) : never;
}

/** index.html 里要移除的底栏按钮 data-view。 */
export function omittedViews(edition, apps = APPS) {
  return [...new Set([...omittedApps(edition, apps).flatMap(app => app.views), ...(EDITIONS[edition]?.hideViews ?? [])])];
}

/** 清单自身的一致性检查，返回错误列表。 */
export function validateManifest(apps = APPS) {
  const errors = [], ids = new Set(), owners = { api: new Map(), pages: new Map(), views: new Map(), routeModules: new Map(), assets: new Map(), data: new Map(), artifacts: new Map() };
  for (const app of apps) {
    if (ids.has(app.id)) errors.push(`应用 id 重复：${app.id}`);
    ids.add(app.id);
    if (!TIERS.includes(app.tier)) errors.push(`${app.id}：档位无效 ${app.tier}`);
    if (app.switchable && app.tier !== 'optional') errors.push(`${app.id}：只有可选应用能设为 switchable`);
    if (app.switchable && !app.description) errors.push(`${app.id}：switchable 应用必须有 description`);
    for (const key of Object.keys(owners)) for (const raw of app[key] ?? []) {
      const value = key === 'data' ? dataName(raw) : raw;
      const prior = owners[key].get(value);
      if (prior && prior !== app.id) errors.push(`${key} "${value}" 同时归属 ${prior} 与 ${app.id}`);
      owners[key].set(value, app.id);
    }
  }
  for (const app of apps) for (const need of app.softRequires ?? []) if (!appById(need, apps)) errors.push(`${app.id}：软依赖了不存在的应用 ${need}`);
  for (const app of apps) for (const read of app.dataReads ?? []) {
    const [ownerId, name] = read.split(':');
    const owner = appById(ownerId, apps);
    if (!owner || !name || !(owner.data ?? []).some(entry => dataName(entry) === name)) errors.push(`${app.id}：dataReads "${read}" 指向不存在的数据`);
    if (ownerId === app.id) errors.push(`${app.id}：dataReads 不要登记自己的数据（${read}）`);
  }
  const rank = { core: 0, optional: 1, private: 2 };
  for (const app of apps) for (const need of app.requires ?? []) {
    const target = appById(need, apps);
    if (!target) { errors.push(`${app.id}：依赖了不存在的应用 ${need}`); continue; }
    if (rank[target.tier] > rank[app.tier] && !(app.debt?.length)) errors.push(`${app.id}（${app.tier}）依赖 ${need}（${target.tier}），违反分层且没有登记 debt`);
  }
  return errors;
}

/** 反查：某个 api 前缀 / 路由模块 / 静态资源 / 底栏 view / 数据名归属哪个应用。 */
export function ownerOf(kind, value, apps = APPS) {
  return apps.find(app => (app[kind] ?? []).some(entry => kind === 'data' ? dataName(entry) === value : entry === value));
}

// ───────── 应用开关（设置里启用 / 关闭可选应用）─────────

/** 该实例里用户能开关的应用：switchable 且该版本发布了它。edition 为 'full' 表示维护者自己的完整实例（全部应用都在）。 */
export function switchableApps(edition, apps = APPS) {
  const shipped = edition === 'full' ? apps : shippedApps(edition, apps);
  return shipped.filter(app => app.switchable);
}

/** 关闭 off 里的应用后，实际不可用的应用 id：它们本身，加上硬依赖（requires）了它们的应用（如日程依赖笔记）。 */
export function withDependents(off, apps = APPS) {
  const result = new Set(off);
  let grew = true;
  while (grew) {
    grew = false;
    for (const app of apps) if (!result.has(app.id) && (app.requires ?? []).some(id => result.has(id))) { result.add(app.id); grew = true; }
  }
  return result;
}

/** 请求路径是否属于已关闭的应用：api 前缀、页面前缀，以及 /games/<产物 id>（按产物归属）。 */
export function isPathOfApps(path, appIds, apps = APPS) {
  const set = new Set(appIds);
  if (!set.size) return false;
  const games = path.match(/^\/games\/([^/]+)/);
  if (games) {
    const owner = apps.find(app => (app.artifacts ?? []).includes(games[1]));
    if (owner) return set.has(owner.id);
  }
  return apps.some(app => set.has(app.id) && (
    app.api.some(name => path === `/api/${name}` || path.startsWith(`/api/${name}/`)) ||
    app.pages.some(page => page !== '/games' && (path === page || path.startsWith(`${page}/`)))));
}

/** 产物 id 属于哪个应用（没有登记的产物不受开关影响）。 */
export function appOfArtifact(artifactId, apps = APPS) {
  return apps.find(app => (app.artifacts ?? []).includes(artifactId));
}
