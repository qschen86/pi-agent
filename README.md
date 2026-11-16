# pi-agent Homebrew 发行

首发为 Apple Silicon Mac 的本机浏览器工作台。用户自行持有电脑、模型账号与数据；不接入维护者的线上实例。Homebrew 配方要求 macOS 15 或以上及 Node 24，具体系统支持以干净设备验收为准。初始化检查至少 16GiB 内存、40GB 可用空间和 Seatbelt。

## 当前状态

本目录复用原本机原型的配置向导和业务适配，新增 Homebrew 命令、实例锁与发行构建。只使用 Homebrew 分发。当前通过 qschen86/pi-agent 源码仓库及 qschen86/homebrew-pi-agent Tap 提供预发布验收版本。

## 安装与使用

用户执行：

```sh
brew tap qschen86/pi-agent
brew install qschen86/pi-agent/pi-agent
brew services start pi-agent
pi-agent status
pi-agent open
```

向导帮助设置本机管理员密码、连接自己的模型账号并完成首次任务。模型调用可能产生供应商费用。Codex / Claude 为可选组件，按向导检查并由用户自己授权。

| 命令 | 行为 |
| --- | --- |
| `pi-agent --version` | 显示已安装的软件版本，不启动服务 |
| `pi-agent status` | 校验进程及本机服务身份；身份无法确认时显示 unverified 并返回退出码 2 |
| `pi-agent status --json` | 机器可读状态，输出不含启动令牌 |
| `pi-agent open` | 在默认浏览器打开已运行的实例；未运行时提示启动命令 |
| `pi-agent serve` | 前台运行服务，用于 Homebrew 或排障；不会自动打开浏览器 |

`open/status/serve` 可附加 `--data-parent /绝对目录`，用于独立测试实例。默认实例保存在 `~/Library/Application Support/pi-agent/instance/`；控制文件 `service.json` 含私密令牌，权限为 0600。服务仅监听 127.0.0.1，端口自动分配。不要分享控制文件、原始日志或实例备份。

服务生命周期由 `brew services start/stop/restart pi-agent` 管理，使用普通用户权限。第一阶段没有接入向导的自动启动开关；该开关不会创建额外 LaunchAgent。暂不支持 Linux、手机连接或公网访问。

Homebrew 服务日志位于其前缀下的 `var/log/pi-agent.log`。`status` 不输出启动令牌；无法确认身份时不要把实例视作已停服。

卸载软件前先停止服务；Formula 不删除实例数据。升级恢复链路尚待后续实现，当前候选版本不应直接用于唯一的生产数据副本。

## 维护者构建

先安装固定锁文件的依赖，准备经过核验的 Pi npm 包、Node 24 配套 npm 包和图像库对应源码。构建不读取维护者的账号配置，不携带独立 Node 二进制。

```sh
npm ci --ignore-scripts
python3 scripts/prepare-homebrew-image-sources.py --output /tmp/pi-image-sources
node scripts/build-homebrew-release.mjs \
  --pi-source /absolute/pi-package \
  --npm-source /absolute/npm-package \
  --image-sources /tmp/pi-image-sources \
  --repository OWNER/REPOSITORY \
  --output dist/homebrew-release
```

`--repository` 必须明确指定。输出目录必须不存在。构建生成：

- `pi-agent-VERSION-macos-arm64.tar.gz`：可审查的程序载荷，不含用户数据。
- `pi-agent-VERSION-source.tar.gz`：本项目对应源码与固定锁文件。
- `pi-agent-VERSION-image-library-sources.tar.gz`：图像库对应源码、补丁、构建配方及收据。
- `pi-agent.rb`：使用实际载荷 SHA256、固定版本 Release URL 的 Formula。
- `INSTALL.md`、`SHA256SUMS`。

源码包包含工作区源码、根依赖锁文件及公开版构建脚本，可按上述命令重新构建。`apps/homebrew/build-inputs.json` 固定 Pi 与 npm 的包名、版本；载荷的逐文件 SHA256 及依赖清单记录实际输入。外部准备的 Pi 依赖树仍需由维护者核验来源，构建器不会把版本号检查当成来源认证。Node 通过 Formula 的 `node@24` 单独安装；原生 npm 模块仅打包 darwin-arm64。

生成 Formula 使用 `opt` 稳定入口，并只在安装时替换 Node 路径。遵循 [Homebrew Formula 文档](https://docs.brew.sh/Formula-Cookbook)。不包含安装时访问维护者电脑、全局 npm 或自动导入登录态的步骤。

先验证测试、类型检查、实际构建和文件校验，再将同一版本的资源发布至 GitHub Release，最后将 `pi-agent.rb` 放到自建 Tap 的 `Formula/` 下。不要覆盖已发布的版本资源。构建器不会自动建仓、上传或更新线上实例。

## 验收边界

本机命令和结构烟测不能代替干净 Mac 的 Homebrew 安装、后台服务重启、真实模型任务或跨版本升级验收。执行记录见 ACCEPTANCE.md。正式发布前必须补齐未验证项。

## 来源与许可证

向导、本机服务和核心打包适配由 apps/homebrew 维护，公开发行采用 Homebrew。自有代码沿用该原型的 MIT LICENSE，第三方依赖保持各自许可。图像库的对应源码附件与载荷必须一并发布。
