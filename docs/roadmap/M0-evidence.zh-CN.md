# M0 验证结果与决策

[English](M0-evidence.md) · 简体中文

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [验收标准](M0.zh-CN.md) · [实验设计](M0-design.zh-CN.md)

A、B 在所测版本上通过。项目所有者批准推进 Runtime，C、D 保持待补。[M1 Runtime 和私有启动](M1.zh-CN.md)

| 门槛 | 状态 | 证据 |
| --- | --- | --- |
| A — Runtime 与 Profile | 对测试的包和升级版本组合通过 | [Runtime 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353929974)、[原生构建作业](https://github.com/sagehou/dsh-workstation/actions/runs/44460118655/job/135344573520) |
| B — 共享 Chromium | 对固定版本及测试夹具通过 | [共享标签页、同源路由和重启后恢复配置](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930294) |
| C — 独占 | Agent 租约和接管排空通过。人工交给 Agent 时仍有已按住输入。 | [独立 Provider 证据](M0-provider-evidence.zh-CN.md#实际结果) |
| D — DSH 插件 API | ACP 通过官方 MCP 限制浏览器调用。原生浮动最大化与还原仍未通过。 | [侧栏生命周期作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328) |

## 确切的上游版本

| 组件 | 记录的版本和来源 |
| --- | --- |
| DSH | 验证时为 `latest=0.2.2-rc.1`、`next=0.2.2-rc.5`、`alpha=0.2.2-alpha.3`。两个测试版本均要求 Node `>=24.9.0`，`dsh` 入口是 `lib/bin.js`。[npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fdsh) · [`dsh-v0.2.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db) · [`dsh-v0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb) |
| Runtime | Node `24.22.3` Bookworm slim、pnpm `11.28.5`、运行时观察到的 Git `2.39.5`、UID `1000`。 |
| 原生探针 | `node-pty@1.2.0-beta.15`、`node-gyp@11.5.0`，用基础镜像自带的 Node 头文件。 |
| 浏览器 | Chromium `156.0.8078.79`、CDP `1.3`、Selkies `2.2.1`、Pixelflux `2.2.3`、PCMFlux `2.2.1`。[Chromium 脚本源码](https://github.com/linuxserver/docker-chromium/tree/4ec00555069627093b9110daff841d363f9a95f8/root) · [baseimage-selkies `debiantrixie-60ce2ea6-ls152`](https://github.com/linuxserver/docker-baseimage-selkies/releases/tag/debiantrixie-60ce2ea6-ls152) · [Selkies `2.2.1`](https://github.com/selkies-project/selkies/tree/d6b9351421bd503ffa89bdee78e2bce758b1ffe5) |
| 代理和驱动 | Traefik `3.7.19`、`playwright@1.61.1`。独立的官方 DSH Browser Use 包 `0.2.2-rc.1` 使用 `@playwright/mcp@0.0.80`。 |

### 镜像摘要

- Runtime `node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`
- 浏览器 `lscr.io/linuxserver/chromium:075b0b99-ls64@sha256:6d2a8da6a45d4083a7287211a619ca29fdb518ebea0ef562c27392ba2f6698d2`
- 浏览器 `linux/amd64` registry 清单 `sha256:995fa4a4278d8ee90a13c33e983c45606aec8bd69bf6236b7c68cf07c89d16f4`
- 代理 `traefik:v3.7.19@sha256:a6c0194dda77bcb804824580f36fa7edc56e315b1acfe933366c8b52844a78a4`
- 驱动 `mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`

### 复查上游元数据

```sh
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh' | jq '."dist-tags"'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.1' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.2-rc.5' | jq '{version, engines, bin, dist: .dist.integrity}'
curl -fsS 'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags' | jq '.[] | {name, sha: .commit.sha}'
curl -fsS 'https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-sidebar-right/-/dsh-client-ui-sidebar-right-0.2.2-rc.1.tgz' \
  | tar -xzOf - package/lib/types/client/tab-registry.d.ts
docker buildx imagetools inspect 'lscr.io/linuxserver/chromium:075b0b99-ls64'
```

## 远端复现

- 使用 GitHub Actions `ubuntu-24.04` 和全新状态。记录的环境为 Docker `28.0.4`、Compose `2.38.2`。向 `m0/issue-1` 推送探针或工作流改动时触发。[工作流](../../.github/workflows/m0.yml)
- 脚本为 Compose 项目使用隔离的名称，执行后删除测试卷。日志不记录 DSH 启动 URL、令牌或 Cookie。

提交 `93a31de` 的四个探针作业通过，各自覆盖当时实现的断言。单独的原生构建被跳过。C、D 剩余验收项保持开放。[提交 `93a31de` 的最终运行](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576)

```sh
# Gate A — Runtime and Profile.
bash prototypes/m0/runtime/run.sh

# Gate B and the human input part of Gate C.
bash prototypes/m0/browser/run.sh
bash prototypes/m0/browser/run.sh --exclusive

# Gate D — Sidebar fixture.
bash prototypes/m0/browser/sidebar/run.sh
```

### 一次获批的原生构建

明确批准了提交 `058e789` 的一次远端构建。记录的命令如下。[提交 `058e789`](https://github.com/sagehou/dsh-workstation/commit/058e789)

```sh
docker compose -f prototypes/m0/runtime/compose.yml run --build --rm --no-deps -T runtime bash /m0/native.sh
```

- 作业用 `--ignore-scripts` 安装，移除 `node-pty` 预构建产物，再以 UID `1000` 执行固定版 `node-gyp` rebuild。
- 实际加载 `build/Release/pty.node`。输出包含 `gyp info ok` 和 `source-built node-pty emitted expected PTY output as uid 1000`。
- 重跑须单独批准。这次只检查独立 PTY，插件生命周期脚本和 DSH Web 终端不在测试范围内。

## A — Runtime 和 Profile

### Web 启动

- `dsh web --no-open --port 0` 按需初始化自带的 Web Profile。探针用启动 URL 换 Cookie，检查已认证启动页返回 HTTP 200。[CLI 参考](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/apps/cli/reference/README.md)
- 所测版本拒绝 `--host 0.0.0.0`，有意让就绪检查失败时用到这条启动路径。[Web 应用绑定、Host/Origin 和会话规则](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/web-app/README.md#public-deployments)

### 插件安装与激活

[Plugin Manager 参考](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md)

- `dsh plugin --profile web add` 使用官方 pnpm 操作。原型采用 `--save-exact --ignore-scripts --ignore-workspace-root-check`。
- npm 测试包为 `@deepseek-ai/dsh-experimental-badge-skill-bundle@0.2.2-rc.1`。
- Git HTTPS 测试包为 `git+https://github.com/sagehou/dsh-workstation.git#8a1d8c03ff3e2f94abc82792ed0771bc82b6fb63&path:/prototypes/m0/runtime/fixture`。
- 区分已保存的依赖、在 `dsh.profile.bundles` 启用和成功加载。Git 测试包在每次就绪检查时写入新的启动标记。
- 按 Bundle 层 → Profile patch → home patch → CLI 叠加配置的顺序加载。内置 Bundle 从所选 DSH 安装解析，其余从 Profile 解析。

- Plugin Manager 提供 Web Plugins 页面及 `plugin_manager` 工具。`inspect`、`installBundle`、`listBundles` 分别用于区分来源元数据、安装和激活。Profile HMR 可以实时应用，只在启动时加载的 Profile 可能要重启。
- 兼容检查使用声明的 `engines.dsh` 和 DSH peer 范围。Git 元数据在拉取后检查，拒绝操作可能在 Store 留下文件。确切版本的豁免保存在 Profile 的 `compatibility.json`，与脚本批准分开。CLI 测试未使用两者。[兼容性契约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/boot/plugin-manager/README.md#version-compatibility-and-exemptions)

### 持久化路径

| Runtime 容器内路径 | 归属和证据 |
| --- | --- |
| `/dsh-home/runtime/versions/<version>` 和 `/dsh-home/runtime/current` | 仅原型使用。在 `flock` 锁下暂存并原子更新符号链接。`current` 指向活动版本。 |
| `/dsh-home/profiles/web/package.json`、`cordis.patch.yml`、`compatibility.json` | 上游依赖和有序 Bundle 清单、Profile 叠加配置及可选的精确兼容性豁免。重建前后及双向切换版本时，清单和 patch 摘要一致。 |
| `/dsh-home/profiles/web/pnpm-lock.yaml`、`pnpm-workspace.yaml`、`node_modules/.pnpm` | 插件锁文件、原型 Store 与脚本策略、解析后的包链接。两个测试包的清单、patch 和链接目标一致。 |
| `/dsh-home/pnpm/store/v11` | 实验选用的 Store 路径，不是上游默认值。pnpm 报告使用内容寻址 Store 的硬链接。容器重建前后，Store 文件集合的指纹一致。 |
| `/dsh-home/cordis.patch.yml`、`.credentials.yaml`、`sessions/`、`storages/` | Home 叠加配置和基础 Profile 数据保存在同一个卷。探针未测试真实凭据，或已保存对话的迁移与恢复。[基础 Profile](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/bundle/base/cordis.patch.yml) |
| `/workspace`、`/backup` | 独立卷。原型在修改 Profile 依赖或切换版本前对 DSH_HOME 做快照。 |

### 切换和回滚结果

[提交 `5686d9e` 的 Runtime 作业](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880883)

```text
installed DSH 0.2.2-rc.1 in /dsh-home/runtime/versions/0.2.2-rc.1
authenticated Web boot OK; Git bundle apply: observed
container recreated: image unchanged
installed DSH 0.2.2-rc.5 in /dsh-home/runtime/versions/0.2.2-rc.5
readiness rejected DSH 0.2.2-rc.5; pointer restored to versions/0.2.2-rc.1
[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for @deepseek-ai/dsh@0.0.0
active DSH 0.2.2-rc.5
active DSH 0.2.2-rc.1
runtime/plugins: tested both DSH versions, recreation and two rollback paths on one image
```

- 两个版本都能启动 Profile，无需修改依赖就加载 Git 测试包。容器重建后 Store 和锁定的插件依赖仍保留。
- 指针回滚无法撤销数据迁移。本次未验证 Plugin Manager 内的原生构建、Git `prepare` 脚本、额外系统库或其他插件兼容性。
- 官方管理器可按 Profile 批准审查过的确切待处理 `allowBuilds` 键。

## B — 同一个浏览器进程与配置目录

### 实验环境

- LinuxServer 将 `CHROME_CLI` 传给 Chromium。探针使用 `/config/m0-chromium` 和 CDP 端口 `9222`。[`autostart_wayland`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/defaults/autostart_wayland) · [`wrapped-chromium`](https://github.com/linuxserver/docker-chromium/blob/4ec00555069627093b9110daff841d363f9a95f8/root/usr/bin/wrapped-chromium)
- 中继与 Chromium 共用网络命名空间，只由隔离网桥访问回环监听。实验检查宿主机访问被拒绝，以及对等容器能读取 `/json/version` 和 `/json/list`。

### 标签页共享与重启结果

- Selkies 输入打开了 CDP 可见的标签页并写入持久化 Cookie。Playwright 创建的标签页接受 Selkies 输入，在同一个默认上下文里读到相同 Cookie。
- 作业确认受管桌面只有一个 Chromium 主进程，检查实际命令行、配置路径和重启前落盘的 Cookie。单独的无头浏览器只用于操作 Selkies。[`d71856d`](https://github.com/sagehou/dsh-workstation/actions/runs/44461308475/job/135348481161)

```text
no host ports published; host CDP probes denied
private peer CDP: Chrome/156.0.8078.79; protocol 1.3
same-origin HTTPS iframe received Selkies WebSocket video through the unchanged /browser/ prefix
human-side Selkies keyboard opened a tab visible in CDP and set a cookie in the default context
agent-created tab accepted Selkies input and shared the human-set cookie
Chromium reported an enforced frame-ancestors denial for the cross-origin iframe
test cookie committed to the persistent Chromium profile
persistent cookie still present in the default context after Chromium restart
```

较早的运行分别在重启后未读到 Cookie、在界面键盘导航阶段停止。通过的探针先等待视频帧，再激活初始标签页中聚焦的链接。[重启后 Cookie 断言](https://github.com/sagehou/dsh-workstation/actions/runs/44459609588/job/135342898428) · [到达持久化测试前的界面键盘导航](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880671)

### 路由和范围

- 设置 LinuxServer `SUBFOLDER=/browser/`，让 Traefik 保留前缀。内置 Nginx 使用这个前缀并把 API 代理给 Selkies。[内置 Nginx 模板](https://github.com/linuxserver/docker-baseimage-selkies/blob/6379480bcbd4ba42c1f5d4ab5eca49304fdedf83/root/defaults/default.conf)
- 测试 ForwardAuth 拒绝未认证的应用请求和 `/browser/` API。已认证的同源 iframe 通过 WebSocket 播放视频。
- Traefik 应用 `frame-ancestors 'self'` 和 `X-Frame-Options: SAMEORIGIN`。浏览器拒绝了同一个站点内、另一个 HTTPS 源的 iframe。
- 应用路由使用测试服务，本次未测试官方 DSH 启动令牌交换和实际认证服务。

- 探针连接 `browser.contexts()[0])，断开后桌面继续运行。Agent 工具不得关闭共享浏览器或上下文。
- CDP 功能完整性、下载持久化与 Provider 断开后的恢复不在本探针范围内。

## C — 独占控制

### Selkies 输入路径

- Selkies `2.2.1` 在两种传输方式中应用安全模式的输入权限规则。本探针固定使用 WebSocket。[`SELKIES_MASTER_TOKEN` 和 `POST /api/tokens`](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/docs/secure-mode.md) · [输入权限规则](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/sessions.py#L62)
- 直接发送键盘和鼠标帧，统计 CDP 目标实际收到的事件。同一个连接在锁定前后可以传递输入。锁定期间计数不变，视频继续更新。

以下为 `d71856d` 的观察结果。

```text
Selkies server denied raw keyboard and mouse frames while the same socket received new video
restoring the token table re-enabled keyboard and mouse on the existing socket
```

- `5686d9e` 的安全模式作业因 `Selkies secure-mode control plane unavailable` 停止。通过的探针改用结尾无换行的单行 Compose secret，仅打印状态，并把令牌管理排除在公网浏览器路由之外。[`5686d9e`](https://github.com/sagehou/dsh-workstation/actions/runs/44460212791/job/135344880925)
- WebRTC、其他输入或设备路径、交接时已按住的键或按钮，以及 Selkies 重启后的安全行为仍需在适用情况下验证。

### DSH 工具和 CDP 路径

- 门槛 B 的 CDP 中继仅用于实验。
- 官方 Browser Use Playwright MCP Provider 支持 `mode: attach` 和 `endpoint`。Session 预留在各 Provider 实例内有效。`ctx.browserUse` 注册 Provider，没有统一的操作拦截钩子。[Browser Use Playwright MCP Provider](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/experimental/browser-use-playwright-mcp/README.md)
- `ctx.tools.guard` 可在分派前拒绝工具调用。Agent 的执行环境若能直连 CDP，就能绕开该守卫，因此 CDP 须隔离。[`ctx.tools.guard`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/tools.md#ctxtools--tools) · [流水线](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L213)

- 单独获批的 Provider 使用 ACP Profile 的官方 Streamable HTTP MCP。测试通过租约、接管排空、过期、并发、旧代次，以及 DSH、Chromium 和 Provider 的断开或重启。只有 Provider 能访问私网 CDP。[独立 Provider 实验](M0-provider-evidence.zh-CN.md) · [Streamable HTTP MCP 集成](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/mcp.md)
- **按住鼠标键的场景失败。** 授权前按住的鼠标键直到回到 HUMAN 才能释放。给 Agent 控制权前，需要受支持的方法停止并释放已进入浏览器的输入。

## D — 原生侧栏生命周期

### 公开 API 和探针

- 公开接口包括 `dsh.client`、Bundle 的 `./client` 导出、`ctx.sidebarRightTabs.register`、`sidebar.right.pane.tab` 插槽及 `keepMounted`。[侧栏文档](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/sidebar-right.md) · [客户端模块契约](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/client-modules.md)
- 通过 Plugin Manager 安装本地 Bundle，用固定上游预设打包客户端。iframe 加载同源测试响应，通过加载次数及帧内值判断浏览上下文是否保留。[固定的上游预设](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/tsdown.client.ts#L1-L12)

| 能力 | 上游行为 |
| --- | --- |
| 浮动和停靠 | 公开服务提供 `float`、`dock`。浮动标题栏支持拖动、调整大小和停靠。[公开服务](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L249-L298) · [标题栏与大小调整手柄](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-dockkit/src/components/FloatLayer.tsx#L311-L345) |
| 最大化与还原 | 全屏和还原适用于停靠列。浮动面板没有最大化、还原。[停靠列](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx#L273-L292) |
| 隐藏 | 公开的 `hide` 会关闭浮动标签。`keepMounted` 不能保留已关闭的 iframe。独立 Chromium 容器继续运行。[`hide` 实现](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/service.ts#L577-L585) |
| 第二个测试版本 | `0.2.2-rc.5` 的服务和浮动标题栏有同样的限制。[`0.2.2-rc.5`](https://github.com/deepseek-ai/deepseek-harness/tree/9c2670d3bce5275e0d1610272958121af87787bb/packages/client) |

### 生命周期结果

- 首次诊断出现 `web boot: 1 entry did not activate`（`dsh-m0-sidebar-probe: failed`）。发布的 `SidebarRightTabDefinition` 要求 `guide?: readonly SidebarRightGuideEntry[]`，每项有 `id`。npm `./client` 声明与注册实现均确认是数组。[`f4cd89a`](https://github.com/sagehou/dsh-workstation/actions/runs/44462375518/job/135351996893) · [`SidebarRightTabDefinition`](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/client/ui-sidebar-right/src/client/tab-registry.ts#L61-L137)
- 修正条目和对话定位后，在实际 npm Web 应用上运行。回环地址的模型测试服务使会话完成，无需 DeepSeek 账号。[提交 `93a31de` 的远端侧栏作业](https://github.com/sagehou/dsh-workstation/actions/runs/44462971576/job/135353930328)

```text
npm DSH loaded the external client plugin through its Profile bundle
iframe retained across tab selection and docked hide/show
iframe retained across native float, resize and dock
iframe retained across docked fullscreen and restore
upstream floating hide closes the tab; its iframe does not survive
```

- 原生浮动行为等上游支持。
- 独立 Provider 已通过官方 MCP 在 ACP 中验证工具受控，无需修改 DSH 核心。实验不覆盖官方 Playwright MCP Browser Use 包和 Web Profile 会话在租约下的凭据绑定。

M0 证据于 2026-11-19 UTC 在一次性测试环境收集。
