# Pi runtime

独立启动与扩展装配层，继续使用上游 Pi CLI，不 fork Pi。运行时拥有配置分区、社区权限、OS 沙盒、单次提权、原生 MCP、浏览器子进程和原生会话。终端和 pi-agent 通过同一 supervisor 执行。

### Hermes 私有长期记忆

安装固定版本 `pi-hermes-memory@0.9.10` 并接入只读 Adapter：

```sh
node scripts/prepare-pi-runtime.mjs --root /absolute/operator-owned/pi-runtime-hermes \
  --memory-store-root /absolute/operator-owned/pi-memory \
  --resume-profile /absolute/operator-owned/previous-runtime/profile.json
/absolute/operator-owned/pi-runtime-hermes/bin/pi-runtime --describe
/absolute/operator-owned/pi-runtime-hermes/bin/pi-runtime --memory-health --cwd /workspace
```

记忆目录的父目录须已存在；新目录由安装器创建为 0700。已有目录须含本 runtime 初始化的所有权标记。目录必须独立于工作区和安装代码，不能指向其他 runtime 的私有记忆。配置标记和记忆数据分离，沙盒仅授予 `data` 写入权限，清理单轮临时目录时保留记忆。SQLite 原生依赖使用当前 Node 工具链构建；其他依赖安装脚本仍禁用。

Hermes 在配置记忆的 `pi-ask` 与 `pi-native` 会话启用，提供 `memory_add`、`memory_replace`、`memory_remove`、`memory_search`。记忆由 runtime 自治写入，无须平台批准每条事实；会话搜索和技能管理工具不暴露给模型。`policy-only` 模式使用 custom policy；可在记忆根目录放置 operator 维护的 `startup-policy.json`（格式见 `config/startup-policy.example.json`）。启动时只加载核心偏好和当前项目索引，每组最多 12 条、2000 字符；其他项目索引不进入提示词。文件须为当前用户所有的私有普通文件，不能使用符号链接。它位于 `data/` 外，不是自动记忆抽取的输出；上游 standing instructions 仍关闭。

Custom policy 要求依赖项目历史的任务先检索（具体主题、当前项目、limit=5），新增前检索同一事实，优先替换已有条目；易变信息记录观察日期、状态与证据，旧结论标记 `needs-verification` 或 `superseded`。这些是模型行为指导，不是语义去重或自动状态识别器；不会批量删除历史库。后台整理、压缩和退出的分支读取视图另附一条明确标记为 runtime policy 的维护说明，要求跳过改写重复、按证据更新状态；它不写入原生会话，也不伪装为用户消息。普通工具检索零命中时，runtime 自动以第一个空白分隔关键词重试一次，保留 project/target/category/limit；单关键词、错误、取消不重试。返回 details.searchAttempts 记录尝试；成功回传由既有 provenance 记录实际查询。启动上下文不记作工具检索事件。

项目 Markdown 通过独立的持久路径保存。平台每轮重启 worker，故将 `flushMinTurns` 从上游默认六轮设为一轮，退出时可额外调用一次当前会话模型来沉淀知识。只读模式不启用记忆。`pi-native` 单独从当前 operator profile 加载记忆，不加载社区权限或浏览器工具，保持原生工具权限；已有原生会话保留历史装配指纹，在下一次 worker 启动时接入记忆。正在运行的轮次不被重启。

Hermes 进程会缓存 Markdown，同一记忆库目前采用独占 writer 租约，冲突会在请求模型前明确失败；并行 writer 需配置不同记忆目录。只读 Adapter 不获取 writer 租约，可同时读取已提交的 SQLite 记录。崩溃遗留的 `runtime.lock` 不自动抢占，先核对其 PID。新入口注册后已有会话按原指纹恢复；保留 `--resume-profile` 指向的旧安装。

平台读取接口与限制见 [Runtime memory read port](../runtime-memory/README.md)。本阶段没有归档增量任务、组织知识晋升、AI 冲突裁决或人工待办。

```sh
node scripts/prepare-pi-runtime.mjs --root /absolute/operator-owned/pi-runtime-v1 \
  --browser-executable '/absolute/path/to/Google Chrome for Testing'
/absolute/operator-owned/pi-runtime-v1/bin/pi-runtime --describe
/absolute/operator-owned/pi-runtime-v1/bin/pi-runtime --cwd /workspace --provider deepseek --model deepseek-flash
```

安装产物为 ESM bundle、独立扩展资源、固定社区依赖、profile 和可执行入口。运行时无需 pi-agent 服务或源码目录；仍依赖本机 Node、上游 Pi 和选定 Chromium。只读/询问模式在 OS guard 不可用时拒绝启动。本机验证环境为 macOS、Node 24.19、Pi 1.2。

终端默认为 `pi-ask`，是轻量文本前端，不包含上游 Pi TUI 的完整快捷键和图形交互。`--prompt` 执行一轮；`--state-dir` 指定运行时状态目录（默认 `~/.local/share/pi-runtime`）。`--session /absolute/history.jsonl` 或 `--session-id UUID` 恢复该目录中的已有会话。provider 凭据读取自用户 Pi 配置，或 `PI_CODING_AGENT_DIR`；仅所选 provider 配置复制入私有子进程目录。

持久安装后可注册入口：

```sh
node scripts/register-pi-runtime.mjs --executable /absolute/operator-owned/pi-runtime-v1/bin/pi-runtime
```

运行时 SDK 在新建连接时读取 `~/.config/pi-runtime/connection.json`（可用 `PI_RUNTIME_REGISTRATION` 指定另一绝对路径）。这里只注册 executable，不包含权限规则或凭据。已有文件会先备份；删除注册文件或恢复备份可回滚。注册无须修改或重启平台；旧版服务需先发布支持发现注册文件的 SDK。显式 `PiDriver` invocation / 服务环境入口优先。无注册时保留源码启动器；配置损坏时拒绝启动，避免静默退回另一套装配。注册入口不得位于当前工作区中。已存在原生会话仍按历史装配续聊。

也可显式设置 `PI_AGENT_PI_RUNTIME=/absolute/operator-owned/pi-runtime-v1/bin/pi-runtime`。平台传递工作区、模型、权限模式、会话与输入，接收 RPC 事件和审批，不读取社区 profile 或执行提权命令。运行时自己读取安装旁的 `profile.json`；可用 `--profile` 或 `PI_RUNTIME_PROFILE` 指定。社区权限与浏览器组件只用于新建 `pi-ask` 会话；记忆另支持 `pi-native`。旧会话按原装配续聊；已装配会话拒绝配置变化。平台原权限模式的默认选择保持现有产品行为。

源码树默认开发入口：`node packages/pi-runtime/bin/pi-runtime.mjs`。`scripts/prepare-pi-community.mjs` 是新安装器的兼容入口。原 runtime-sessions 下实现文件暂保留 re-export；注入假客户端/guard 的适配器测试使用 runtime 包的 embedded transport，生产连接使用独立进程。

浏览器默认仍是每次运行的 headless 隔离实例。需要跨运行保留登录状态时，先初始化独立的空目录，再显式配置 `browser.profileRoot`：

```sh
node packages/pi-runtime/bin/pi-runtime.mjs --init-browser-profile /absolute/existing-parent/new-profile
node scripts/prepare-pi-runtime.mjs --root /absolute/operator-owned/pi-runtime-v2 \
  --browser-executable '/absolute/path/to/Google Chrome for Testing' \
  --browser-profile-root /absolute/existing-parent/new-profile \
  --resume-profile /absolute/operator-owned/pi-runtime-v1/profile.json
```

专用目录必须位于工作区外、属于当前用户、仅该用户可访问，含 runtime 创建的所有权标记；普通 Chrome 用户目录不被接管。runtime 使用社区 MCP 公共 API 和 Playwright `storageState` 保存 Cookie、localStorage 和 IndexedDB；这不是完整 Chrome Profile 复制，不承诺保存扩展、Service Worker 或所有网站的登录机制。快照原子写入 `data/storage-state.json`（0600），停止时 supervisor 先确认保存，再退出 Pi/清理进程组；原状态不会因一次保存失败被覆盖。断电、SIGKILL 等强制终止不能保证保存本轮新状态。

同一专用 Profile 同时只允许一个 runtime 运行，冲突在模型派发前失败；并行任务使用独立 Profile 或默认隔离模式。崩溃留下 `runtime.lock` 时不自动抢锁，先核对锁内 PID，确认其 runtime/浏览器已退出后才由操作者清理。外层浏览器进程树只增加该 Profile 的 `data` 写入根；命令执行器不继承这份写入授权，所有权标记和租约目录仍受保护。

`--resume-profile` 固定旧版本的可信配置；已有原生历史仅在装配指纹完全匹配时使用它，不会改装为新持久模式。保留该旧安装与依赖直至相关会话不再需要续聊。注册新入口前先完成客户端优雅关闭 SDK 的发布；注册文件本身仍只有 executable。持久能力验证不等于已经登录任何真实网站。

为嵌套 Seatbelt 兼容，关闭 Chromium 自身的内层 sandbox，外层 Pi 整进程树的文件沙盒保持启用；网络仍可访问。Computer Use 尚未启用。外置二进制尚未绑定正式评估资格，因此平台对外置 runtime 的正式评估失败关闭；普通会话可用。源码默认入口的资格标识包含运行时代码和独立浏览器生命周期资源，但正式资格仍须重新验收。


### Community permission cards

The runtime converts pinned community permission dialogs into structured approval requests. The frontend renders immediate Deny / Once / Session buttons; ordinary questions keep their question UI. A session choice is runtime-owned, bound to the native session, workspace, assembly and complete tool inputs, and survives per-turn worker restarts. It grants only an identical request, never a platform-wide auto-approval or a wider community directory pattern. Runtime state defaults to `~/.local/share/pi-runtime/permissions`; the operator can set `--state-dir` or `PI_RUNTIME_STATE_DIR`. The location must be outside the workspace. OS permission expansion remains once-only.

## Structured facts (opt-in)

`<memory profile>/facts-policy.json` is private operator-owned configuration, outside writable `data/`. Start with `config/facts-policy.example.json` (disabled). Five predicates have deterministic schemas: component version, serving revision, release status, path location, and scalar config value. Automatic replacement requires an evidence reference created by an allowlisted collector; model prose, timestamps and confidence cannot authorize a replacement.

Operator CLI: `--memory-facts-collect <collectorId> --subject <subjectId>` records a verified observation. Model tool `memory_fact_submit({candidate})` forwards one typed candidate to the same guarded publication path as legacy tools. Canonical facts cannot be edited/deleted through legacy replace/remove or consolidation. Raw explicit candidates use `@runtime-fact/v1 <single-line JSON>`; arbitrary natural language remains unverified, not semantically conflict-free.

`--memory-facts-scan` reads only the current project/global legacy snapshot, reports template coverage and candidate conflicts, and never calls a collector/model or migrates historical content. It is not a claim that unparsed prose contains no conflicts. See the approved design and implementation plan for evidence and release boundaries. Production activation is separate from implementation.
