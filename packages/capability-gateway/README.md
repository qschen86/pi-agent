# Capability Gateway (v4.03 / M0+M1)

宿主持有受限 Token。运行时只获得本轮 socket，调用固定的 search / describe / invoke；模型不得指定身份、URL、HTTP 方法、shell 或通用 Code Mode。该包不依赖任何 runtime，脱敏器由宿主注入。

- `contracts.ts`：连接、能力、授权、执行、审批、审计契约；输入为严格的能力 schema。
- `store.ts`：沿用 Node 24 `node:sqlite`；`user_version=1`、可重复迁移，未知新版本拒绝打开。凭据不入库。
- `vault.ts`：独立 0700 目录、0600 原子文件、随机引用、拒绝链接和路径逃逸。
- `gateway.ts`：每次调用读取授权，连接 / 授权 / 宿主执行上下文取交集，缺失拒绝；审批等待后重新校验。任何 write 都需要真人单次批准，不能由 AUTO 或会话全部批准绕过。
- `adapters.ts`：GitHub 与 Cloudflare 固定 REST 请求；禁止重定向，限制响应体，取消/超时可终止读取，写入不自动重试。

`DUAL` 会被保留并拒绝执行：当前单用户平台没有可验证的第二位审批人，不能把双人审批降成一次点击。默认只读授权为 AUTO；写能力仍逐次审批。多个 Grant 只会使用一个完整覆盖操作的 Grant，不能拼接不相交权限。

宿主数据位置由 `appData(dataDir,'resources').path('capability-gateway')` 决定，兼容 flat 和 apps 布局，使用现有 resources 备份范围。子目录 `gateway.sqlite` 和 `vault/` 必须一起备份；蓝绿实例各用自己的数据目录，不复制令牌。回滚停止新版进程后使用旧版，旧版不会读这个新增目录；保留新增目录即可再次升级，不能把数据库降版本后交给新版继续写。凭据轮换先验证后持久化，断开连接删除密钥并撤销授权。

API 接在现有登录、Host、Origin 与公开入口权限中间件之后；管理写入需 publicControl，读取需 publicHistory/publicControl。本机访问沿用平台既有可信本机边界。

安全边界：0700/0600 保护不同 OS 用户，**不保护具有同一 OS 用户完整文件/命令权限的进程**。平台 API 和桥接不会向 Agent 提供令牌或 Vault 路径；无沙盒/Full access 的 runtime 仍可用本机命令绕过文件级隔离，和用户自行登录的 gh/wrangler 一样不能宣称受网关强隔离。Pi 工作区沙盒沿用其家目录默认拒读边界。本期不改变用户选择的完整本机权限，也不宣称由网关撤权撤销 CLI 自带的权限。

测试使用合成 Token、临时目录、本机合成模型服务；`security.test.ts`、runtime 的 `capability-access.test.ts / capability-native.test.ts` 和 Web 的 `capability-routes.test.ts` 覆盖安全与接线。真实账号权限、外部部署结果和手机真实键盘需要独立验收，不以 mock 冒充。
