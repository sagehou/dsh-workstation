# 公网 Compose

[English](README.md) · 简体中文

[网络地址](#网络地址) · [选择部署形态](#选择部署形态) · [部署](#部署) · [使用浏览器](#使用浏览器) · [维护](#维护) · [备份与恢复](#备份与恢复)

## 部署前准备

- **主机**需要 Linux amd64、以 root 运行的 Docker Engine 28+ 和 Compose v2。用有 Docker 权限的非 root 用户执行。不需要镜像仓库凭据：工作台镜像为公开包。
- 发布仅提供 `linux/amd64`。不要在其他架构上运行。
- **DNS** 将工作台域名指向 Traefik 所在主机。Traefik 提供公网端口 80 和 443，并管理证书。
- **Traefik** 须已在同一台 Docker 主机运行。确认它所在的可信 Docker 网络、HTTPS 入口、证书 resolver，以及 file provider 监视的宿主机目录。CI 按摘要固定 `v3.7.14` 与 `v3.7.19`，并用全栈测试覆盖两者。[兼容性矩阵](../../docs/roadmap/public-compose.zh-CN.md#traefik-兼容性矩阵)
- 核对工作台子网与宿主机路由及已有 Docker 网络是否冲突。[网络地址](#网络地址)

## 网络地址

Runtime、Gateway 和 Browser 共用 `workstation`。Traefik 加入该网络以访问 DSH 和 Selkies，并沿用现有代理网访问 Gateway 和 ForwardAuth。

`WORKSTATION_SUBNET` 默认为 `172.30.241.0/24`。`deploy/network.sh` 推导 Runtime 和 Gateway MCP 的 `.2`、`.3` 地址。Docker 从子网的上半段分配动态地址。

启动前先核对方案：

```bash
bash deploy/network.sh check
```

它只报告，不创建也不改动任何东西：

- 与**宿主机路由**重叠的子网（VPN 路由是最常见的情况）；
- 与**现有 Docker 网络**重叠的子网；
- 非法 CIDR、超出 `/16`..`/28` 的前缀，或带主机位的 CIDR。

若失败，选择一段未使用的 RFC1918 地址传给初始化脚本。

```bash
WORKSTATION_SUBNET=10.71.241.0/24 \
  bash deploy/public/init.sh workstation.example.net proxy traefik
```

更改 `WORKSTATION_SUBNET` 时，用 `--reissue` 替换内部 CA 与 Runtime 证书。其他密钥会保留。重建容器以使用新地址。

## 选择部署形态

| 形态 | 工作台常驻容器 | 服务 |
| --- | ---: | --- |
| **精简版（core）** | **2** | `gateway`、`runtime` |
| **完整版（full，默认）** | **3** | `gateway`、`runtime`、`browser` |

两个形态都复用已有 Traefik。把 Traefik 容器计入，总数分别为 3 和 4。`gateway-admin` 和 `maintenance` 只在需要时通过 `docker compose run --rm --no-deps` 执行。

精简版只启动 DSH 和 Gateway，Gateway 的浏览器进程关闭。已登录时访问 `/_auth/browser` 或建立浏览器数据 WebSocket 会返回 503。完整版在 Gateway 内运行 Provider 和输入门禁，Browser 内运行 Chromium、Selkies 和 CDP 中继。使用与 Compose 文件同一提交的 `browser/cdp-relay` 和 `browser/selkies-guard.sh`，保留可执行权限。[三服务拓扑](../../docs/roadmap/public-compose.zh-CN.md#三服务部署)

在仓库根目录设置本次部署使用的 `COMPOSE_FILE`，后续所有 Compose 命令沿用该设置。完整版执行以下命令。

```bash
export COMPOSE_FILE=compose.yml
```

精简版执行以下命令。

```bash
export COMPOSE_FILE=compose.yml:deploy/public/compose.core.yml
```

已有完整版切为精简版时，先从 `dsh-workstation_workstation` 断开 Traefik，再用完整版配置执行 `down`，保留命名卷。按第 4 步重新接入 Traefik。

## 部署

在部署主机的同一个终端按顺序执行。

### 1. 选择部署提交

安装已发布镜像时，从 `main` 读取 `deploy/public/release-commit`，检出对应的部署提交，确认两个固定摘要的 GHCR 引用均可解析。

```bash
git fetch origin main &&
  deployment_ref="$(git show FETCH_HEAD:deploy/public/release-commit)" &&
  git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh
```

使用该检出版本的 Compose 文件与初始化脚本。从源码构建时，在所选源码提交执行 `bash deploy/public/images.sh --local` 查看本地镜像标签。[发布状态](../../docs/release.zh-CN.md#当前部署版本)

### 2. 配置域名和 Traefik

替换下方示例值。初始化脚本会记录 Traefik 在所选网络的 IPv4，并生成路由文件。HTTPS 入口已提供证书时，将 `WORKSTATION_TRAEFIK_RESOLVER` 设为空。

```bash
domain='workstation.example.net'
proxy='proxy'
traefik='traefik'
traefik_dynamic='/srv/traefik/dynamic'

WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
```

`--release` 将两个固定摘要的引用写入 `.env.public`。从源码构建时省略 `--release`，然后在创建管理员前构建镜像。

```bash
docker compose --env-file .env.public build
```

#### 已有部署

沿用原域名、状态目录和工作台子网。已有管理员可跳过创建步骤。[已有部署迁移](#从-auth-迁移到-gateway)

### 3. 创建管理员

```bash
docker compose --env-file .env.public run --rm --no-deps gateway-admin bootstrap admin
```

1. 设置密码。
2. 将显示的 TOTP 密钥添加到验证器，输入当前验证码。
3. 离线保存显示的恢复码。创建首个账号后，初始化功能关闭。

### 4. 启动 Compose 并添加路由

服务启动后将 Traefik 接入一次工作台网络。

```bash
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 420 &&
  docker network connect dsh-workstation_workstation "$traefik"
```

把生成的路由文件放进 Traefik 监视的目录，再用 `ps` 核对已启动的服务。

```bash
install -m 0644 "${WORKSTATION_STATE:-.workstation}/edge/routes.yml" "$traefik_dynamic/.dsh-workstation.tmp" &&
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml" &&
  docker compose --env-file .env.public ps
```

### 5. 登录

1. 打开 `https://<域名>/`。
2. 使用 `admin`、密码和新的 TOTP 验证码登录。绑定时的验证码已使用。
3. 在 DSH 的 **Settings → Models** 填入 DeepSeek API Key。
4. 如需使用独立的 Passkey 登录，在 `/mgmt/account` 添加 Passkey。

## 使用浏览器

完整版提供独立浏览器页面。Agent MCP 默认关闭。生产环境在独占交接通过验收后开放 Agent 控制，在独立出口策略通过验收后开放不可信网站浏览。[交接 #4](https://github.com/sagehou/dsh-workstation/issues/4) · [出口 #11](https://github.com/sagehou/dsh-workstation/issues/11)


| 要做什么 | 在哪里操作 |
| --- | --- |
| 打开共享 Chromium | 在 DSH 会话的右侧栏选「浏览器」，也可以通过 `/_auth/browser` 打开独立桌面。两处沿用工作台登录。 |
| 让 Agent 使用标签页 | Agent 可以通过 `lease_status` 取得空闲租约，也可以在 `/mgmt/browser` 手动授予最长 120 秒的租约。`browser-gate` 确认已按住的输入释放后，才会移交控制权。 |
| 接管浏览器 | 选择 **接管浏览器**。Provider 停止接收新调用，等待当前操作结束后交还控制。 |
| 指定 Agent 可用的网站 | 在 `.env.public` 中设置 `BROWSER_TOOL_ORIGINS`，填逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`，再重建 Gateway。 |

MCP 启用时，Agent 先用 `mcp__browser__lease_status` 获取代次，再调用 `navigate`、`read` 或 `click`。来源清单约束工具调用和返回的页面文本。浏览器网络出口由独立策略控制。[候选版租约行为](../../docs/adr/0006-agent-first-browser-and-default-open-origins.md)

右侧栏入口需要 Runtime 提供浏览器 Bundle 的客户端，并在 Gateway 启用浏览器。折叠停靠的侧栏会保留 iframe。隐藏浮动面板时，DSH 会关闭该页签。`/mgmt/browser` 仍可打开独立桌面。[侧栏 #5](https://github.com/sagehou/dsh-workstation/issues/5) · [上游侧栏验收](../../docs/roadmap/M0-evidence.zh-CN.md)

连接或标签页丢失时，新建 DSH 会话并重新授权。要继续原来的对话，重启 Runtime、恢复对话，再给新连接授权。新标签页使用同一份 Chromium 配置。

### 输入门禁

`browser-gate` 将操作者输入转发至 Selkies。Browser 内的 Nginx 仅接受 `workstation` 网上来自 Gateway 的数据 WebSocket 和令牌管理请求。门禁先释放已按住的输入，等 Selkies 确认后，Provider 才切换控制权。如果无法确认，门禁会在该连接仍有控制权时关闭它，由 Selkies 在断开时释放输入，并拒发本次租约。

不碰浏览器即可检查：

```sh
docker compose --env-file .env.public exec -T gateway node --input-type=module -e '
  import { readFileSync } from "node:fs"
  const s = readFileSync("/run/secrets/gate_control", "utf8").trim()
  const r = await fetch(process.env.GATEWAY_BROWSER_UPSTREAM + "/status", {
    headers: { Authorization: "Bearer " + s },
  })
  console.log(await r.json())
'
```

只有在你持有权限时 `state` 才是 `OPEN`，交接正在确认释放时为 `RELEASING`。`POST /handover` 只有在上游确认释放后才返回 `released: true`。[ADR-0005](../../docs/adr/0005-release-held-input-at-selkies.zh-CN.md)

## 维护

打开 `/mgmt` 查看 Runtime 状态与版本、创建或校验 DSH_HOME 备份、管理账户和交接浏览器。创建备份和校验要求五分钟内验证过身份。通过 CLI 升级、手动回滚、恢复及迁移前的备份，请在停服后执行。[Runtime 维护](../README.zh-CN.md#升级与回滚)

### DSH 升级与恢复

两个镜像均支持 Web 升级时，在 `/mgmt` 选择「升级 DSH」，输入确切的 npm 版本，并按提示验证 TOTP。概览会显示升级阶段、兼容性阻断原因、活动版本和匹配备份 ID。升级期间 DSH Web 暂停服务。Runtime 在副本上检查候选版本，创建备份，切换后启动 DSH 并校验 Profile。若候选版本切换后启动失败，Runtime 会恢复匹配备份并重启原版本。[Web 升级 #48](https://github.com/sagehou/dsh-workstation/issues/48)

通过 CLI 升级时，停止 Runtime 并保持 Gateway 运行。沿用部署时的 Compose 文件和 `--env-file .env.public`，执行 `docker compose --env-file .env.public run --rm --no-deps maintenance upgrade <版本>`。切换后启动 Runtime，确认 DSH Web 可用。再次停服执行 `maintenance verify` 后重启 Runtime。[升级进度 #39](https://github.com/sagehou/dsh-workstation/issues/39)

浏览器 Bundle 使用所选 DSH 自带的官方 MCP 客户端。Profile 启动时会校验客户端配置，候选版本的就绪检查也会执行该校验。部署通过链接加载 Runtime 镜像里的 Bundle 文件，重建 Runtime 后既有安装会加载更新后的客户端。包含侧栏客户端时，`WORKSTATION_BROWSER_MCP=0` 关闭 Agent 连接，完整版仍提供人用浏览器入口。[兼容检查与恢复](../README.zh-CN.md#升级与回滚) · [Bundle 验证 #44](https://github.com/sagehou/dsh-workstation/issues/44)

### 工作区与 Skills

DSH_HOME 归档包含设置、凭据、会话、Profile 插件及其锁文件、`$DSH_HOME/skills` 和 `$DSH_HOME/.agents/skills` 中的共享 Skills。单独备份 `/workspace`，保留项目文件和项目 Skills。若链接的插件或 Skills 指向卷外路径，单独挂载或备份链接目标。

替换旧 Runtime 容器前，执行 `docker compose --env-file .env.public cp runtime:/home/node/.agents/. ./agents-export` 导出旧容器中的共享配置与 Skills。用新 Runtime 将导出文件复制到持久卷的 `/dsh-home/.agents`，保留已有文件。

### Traefik

- 更新 Runtime 0.2.3 和 Gateway 0.1.1 时，使用对应部署提交。沿用原域名、代理网、Traefik 容器和子网重新运行 `deploy/public/init.sh --release`，加载新生成的路由文件。自定义 DSH MCP 配置如引用工作台 Provider，请使用 `http://gateway:8080/mcp`。
- 如需在重建 Traefik 时保留连接，在它自己的 Compose 中将 `dsh-workstation_workstation` 声明为外部网络。
- 若 Traefik 在代理网上的 IP 变化，按[已有部署迁移](#从-auth-迁移到-gateway)的步骤停服并拆除旧网络。沿用已保存的配置重新初始化，再按第 4 步接回 Traefik 并更新路由。

### 浏览器恢复

如果 Provider 无法确认进行中的浏览器操作已经结束，它会拒绝给该 Chromium 进程再授权。可重建 Browser，沿用当前 hostname 和浏览器配置卷。

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate browser
```

Provider 会尝试自动重连。如果 Chromium 已就绪而控制页仍显示 `DISCONNECTED`，选择 **连接浏览器**。

### 账户与会话

| `.env.public` 配置项 | 默认值 |
| --- | --- |
| `GATEWAY_IDLE` | 30 分钟 |
| `GATEWAY_ABSOLUTE` | 12 小时 |
| `GATEWAY_MAX_SESSIONS` | 8 个 |

- HTTP 请求和新的 WebSocket 握手会刷新空闲计时。已建立的 DSH 和 Selkies WebSocket 每两秒检查会话，过期或被撤销后关闭。
- 在 `/mgmt/account` 撤销单个或所有会话。超过五分钟后，修改敏感设置前需验证新的 TOTP。
- 在宿主机停用或启用账号时，把管理员命令中的 `bootstrap admin` 替换为 `disable` 或 `enable`。两者都会使当前会话失效。

### DSH 版本

Runtime 首次启动时安装官方 DSH `0.2.2-rc.1`。启用 Agent MCP 时，Runtime 通过官方 Plugin Manager 将 Workstation 浏览器 Bundle 安装到持久化 Web Profile。Runtime 和 Profile 安装均禁用包生命周期脚本。Bundle 使用已验证的 DSH 版本。

更改 Profile 或版本前备份 DSH_HOME。对公网 Compose 执行维护命令时使用 `--env-file .env.public`。版本回滚只切换 npm 安装，已迁移的数据需要从匹配的备份还原。[Runtime 维护命令](../README.zh-CN.md#升级与回滚)

### 从原有独立部署迁移

1. 在旧提交中执行 `down`。保留命名卷、`.env.public` 与 `.workstation/`。
2. 以相同域名重跑初始化（`--release` 会把镜像切换到按摘要固定的 GHCR 引用）。
3. 跳过管理员初始化，启动新 Compose。

旧容器的 hostname 如果留下浏览器配置锁，应先确认旧 Chromium 已停止，再清理配置卷 `/config/chromium` 下的 `SingletonLock`、`SingletonSocket` 和 `SingletonCookie` 符号链接。[Chromium 配置锁实现](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### 从 auth 迁移到 Gateway

这组步骤也适用于仍使用独立浏览器网络的 Gateway 候选版。

1. 如果目标是发布版本，用 `bash deploy/public/images.sh` 确认两个镜像摘要可解析。停止旧栈并备份 `.env.public`、`.workstation/` 和命名卷。将 Traefik 从已接入的 `dsh-workstation_workstation` 和 `dsh-workstation_browser` 断开。用原 Compose 文件和项目名执行 `docker compose --env-file .env.public down`，保留命名卷。
2. 切换到目标版本，沿用原域名、状态目录及 Traefik 配置，按[第 2 步](#2-配置域名和-traefik)初始化。如已定制 `WORKSTATION_SUBNET`，传入保存的值。初始化会移除 `BROWSER_SUBNET` 和 `BROWSER_IP_RANGE`，在沿用工作台子网时保留 Runtime CA 和证书。
3. 按[第 4 步](#4-启动-compose-并添加路由)启动 Compose，将 Traefik 接入 `dsh-workstation_workstation` 一次，并替换工作台路由文件。用已有账户测试登录、`/mgmt` 和完整版的 `/browser/`。

会话设置优先读取 `GATEWAY_*`，其次读取 `AUTH_*`。如需回退，按前述步骤拆除新栈及其网络，切回原提交，恢复保存的 `.env.public`，按原提交初始化并接回网络。

### 升级与回滚

按前面的迁移步骤备份并拆除运行中的工作台，供初始化执行子网预检。切换到已记录目标镜像摘要的部署提交，沿用原工作台子网。

```bash
# 将 deployment_ref 设为 images.env 已记录目标摘要的部署提交。
workstation_subnet="$(sed -n 's/^WORKSTATION_SUBNET=//p' .env.public)"
git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh &&
  WORKSTATION_SUBNET="${workstation_subnet:-172.30.241.0/24}" \
  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
```

按第 4 步启动 Compose、接回 Traefik 并安装路由。回滚时使用旧部署提交及其网络接入命令。

Runtime 版本回滚是另一件事，不改这些镜像，见 [Runtime 维护](../README.zh-CN.md#升级与回滚)。镜像回滚与数据回滚不同，涉及 DSH_HOME 迁移时必须配一份对应的备份。

Public Compose 工作流上传的 Actions artifact 仍保留 90 天，作为 CI 实际运行内容的审计证据；它不再是分发渠道。[工作流](../../.github/workflows/public-compose.yml)

## 备份与恢复

| 保留内容 | 用途 |
| --- | --- |
| `.workstation/`，与 SQLite 分开备份 | TOTP 加密密钥、服务凭据和内部 TLS 密钥。重新安装时沿用原目录。 |
| `dsh-home`、`workspace`、`browser-profile`、`auth-data`、`provider-state` 命名卷 | DSH、浏览器、认证和 Provider 状态。停止 Compose 后做快照，保留数据时避免使用 `down -v`。 |

备份 Gateway 的 SQLite 数据时，将已停止的 `auth-data` 卷归档到私有位置。

```bash
docker compose --env-file .env.public stop && (
  umask 077
  # 使用部署自身固定的镜像引用。
  set -a; . ./.env.public; set +a
  docker run --rm --network none --user 0:0 --entrypoint tar \
    -v dsh-workstation_auth-data:/data:ro "$WORKSTATION_RUNTIME_IMAGE" \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

停止工作台后，将备份还原到空的 `auth-data` 卷。使用匹配的 `.workstation/secrets/auth-key`，保留归档中的数字 UID/GID 和权限，保留 Passkey 使用的公网域名。Runtime 会重新生成启动 URL。

只有 Traefik 发布端口。共享桌面在独立标签页打开。[测试证据](../../docs/roadmap/public-compose.zh-CN.md)
