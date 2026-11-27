# 公网 Compose

[English](README.md) · 简体中文

[网络地址](#网络地址) · [选择部署形态](#选择部署形态) · [部署](#部署) · [使用浏览器](#使用浏览器) · [维护](#维护) · [备份与恢复](#备份与恢复)

## 部署前准备

- **主机**需要 Linux amd64、以 root 运行的 Docker Engine 28+ 和 Compose v2。用有 Docker 权限的非 root 用户执行。不需要镜像仓库凭据：工作台镜像为公开包。
- 发布仅提供 `linux/amd64`。不要在其他架构上运行。
- **DNS** 将工作台域名指向 Traefik 所在主机。Traefik 提供公网端口 80 和 443，并管理证书。
- **Traefik** 须已在同一台 Docker 主机运行。确认它所在的可信 Docker 网络、HTTPS 入口、证书 resolver，以及 file provider 监视的宿主机目录。**不需要升级 Traefik**：CI 按摘要固定 `v3.7.14` 与 `v3.7.19`，并用同一套全栈测试覆盖两者；哪些版本已有通过记录见[兼容性矩阵](../../docs/roadmap/public-compose.zh-CN.md#traefik-兼容性矩阵)。
- **Docker 网络**用 `bash deploy/network.sh check` 核对两个 Compose 子网与宿主机路由；冲突时会拒绝继续。见[网络地址](#网络地址)。

## 网络地址

两个 Compose 网络及其中的所有地址只来自一处：`deploy/network.sh`。无需手工修改任何文件，且初始化脚本在方案与宿主机冲突时会拒绝执行。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `WORKSTATION_SUBNET` | `172.30.241.0/24` | Runtime 和 Gateway 的认证 MCP 监听器。 |
| `BROWSER_SUBNET` | `172.30.233.0/24` | Browser、Gateway 与 Traefik 到 Selkies 的连接。 |

Runtime 和 Gateway MCP 在工作台网络上使用 `.2` 和 `.3`。Docker 从两个子网的上半段分配动态地址。

启动前先核对方案：

```bash
bash deploy/network.sh check
```

它只报告，不创建也不改动任何东西：

- 与**宿主机路由**重叠的子网（VPN 路由是最常见的情况）；
- 与**现有 Docker 网络**重叠的子网；
- 非法 CIDR、超出 `/16`..`/28` 的前缀，或带主机位的 CIDR。

若失败，选择两段未使用的 RFC1918 地址传给初始化脚本：

```bash
WORKSTATION_SUBNET=10.71.241.0/24 BROWSER_SUBNET=10.71.233.0/24 \
  bash deploy/public/init.sh workstation.example.net proxy traefik
```

Runtime 证书按推导出的地址签发，因此在已有状态目录上用不同子网重跑初始化会被拒绝，而不是静默重签所有服务都信任的内部 CA。`--reissue` 才是有意为之的路径：它替换 CA 与 Runtime 证书，保留其他密钥，并要求重建容器以取得新地址。

## 选择部署形态

| 形态 | 工作台常驻容器 | 服务 |
| --- | ---: | --- |
| **精简版（core）** | **2** | `gateway`、`runtime` |
| **完整版（full，默认）** | **3** | `gateway`、`runtime`、`browser` |

两个形态都复用已有 Traefik。把 Traefik 容器计入，总数分别为 3 和 4。`gateway-admin` 和 `maintenance` 只在需要时通过 `docker compose run --rm --no-deps` 执行。

精简版只启动 DSH 和 Gateway，Gateway 的浏览器进程关闭。已登录时访问 `/_auth/browser` 或建立浏览器数据 WebSocket 会返回 503。完整版在 Gateway 内运行 Provider 和输入门禁，Browser 内运行 Chromium、Selkies 和 CDP 中继。请随 Compose 文件保留同一提交中的 `browser/cdp-relay`，供 LinuxServer 启动。[三服务拓扑](../../docs/roadmap/public-compose.zh-CN.md#三服务候选版)

在仓库根目录设置本次部署使用的 `COMPOSE_FILE`，后续所有 Compose 命令沿用该设置。完整版执行以下命令。

```bash
export COMPOSE_FILE=compose.yml
```

精简版执行以下命令。

```bash
export COMPOSE_FILE=compose.yml:deploy/public/compose.core.yml
```

已有完整版切为精简版时，先用完整版配置执行 `down`，保留命名卷。

## 部署

在部署主机的同一个终端按顺序执行。

### 1. 选择部署提交

安装已发布镜像时，使用 `deploy/public/release-commit` 记录的部署提交。当前为 `81feffd`，服务名是 `auth`，管理员命令使用一次性服务 `auth-admin`。在已克隆的仓库中检出该提交，确认四个镜像引用均可解析。

```bash
git switch --detach 81feffdb5607a28062d03f443d6ff47aeb206665 &&
  bash deploy/public/images.sh
```

继续执行该提交中部署指南的第 2 步。[已发布版本的部署指南](https://github.com/sagehou/dsh-workstation/blob/81feffdb5607a28062d03f443d6ff47aeb206665/deploy/public/README.zh-CN.md#2-配置域名和-traefik)

本页后续步骤适用于 Gateway 源码。若检出版本已记录 Gateway 的发布摘要，先用 `bash deploy/public/images.sh` 确认 Runtime 和 Gateway 的两个引用，再使用 `--release`。当前候选版可从源码构建，用 `bash deploy/public/images.sh --local` 查看构建标签。[发布状态](../../docs/release.zh-CN.md#当前部署版本)

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

沿用原域名、状态目录和子网重跑初始化，保留凭据和证书。已有管理员可跳过创建步骤。[Auth 迁移](#从-auth-迁移到-gateway)

### 3. 创建管理员

```bash
docker compose --env-file .env.public run --rm --no-deps gateway-admin bootstrap admin
```

1. 设置密码。
2. 将显示的 TOTP 密钥添加到验证器，输入当前验证码。
3. 离线保存显示的恢复码。创建首个账号后，初始化功能关闭。

### 4. 启动 Compose 并添加路由

服务启动后将 Traefik 接入工作台网络。每张网络只需接入一次。

```bash
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 420 &&
  docker network connect dsh-workstation_workstation "$traefik"
```

完整版还需将 Traefik 接入浏览器网络。

```bash
docker network connect dsh-workstation_browser "$traefik"
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
| 打开共享 Chromium | 从 `/_auth/browser` 打开同源的 `/browser/`，沿用工作台登录。 |
| 让 Agent 使用标签页 | Agent 可以通过 `lease_status` 取得空闲租约，也可以在 `/mgmt/browser` 手动授予最长 120 秒的租约。`browser-gate` 确认已按住的输入释放后，才会移交控制权。 |
| 接管浏览器 | 选择 **接管浏览器**。Provider 停止接收新调用，等待当前操作结束后交还控制。 |
| 指定 Agent 可用的网站 | 在 `.env.public` 中设置 `BROWSER_TOOL_ORIGINS`，填逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`，再重建 Gateway。 |

MCP 启用时，Agent 先用 `mcp__browser__lease_status` 获取代次，再调用 `navigate`、`read` 或 `click`。来源清单约束工具调用和返回的页面文本。浏览器网络出口由独立策略控制。[候选版租约行为](../../docs/adr/0006-agent-first-browser-and-default-open-origins.md)

连接或标签页丢失时，新建 DSH 会话并重新授权。要继续原来的对话，重启 Runtime、恢复对话，再给新连接授权。新标签页使用同一份 Chromium 配置。

### 输入门禁

`browser-gate` 位于登录代理与 Chromium 数据连接之间，是唯一承载输入的路径。已固定的 Selkies 会在每个帧上按实时令牌表判定输入权限，并且**先**安装新表**再**通告变更，因此权限收回之后发出的释放帧会被丢弃。这就是交接时按住的鼠标键此前会在整个 Agent 租约期间保持按下的原因。门禁会在 Provider 接管权限**之前**，用 Selkies 自带的 `reset_keyboard()` 与 `release_mouse_buttons()` 原语释放已按住输入，并等待上游确认这些帧。若无法证明，它会在该连接仍持有权限时关闭它，让 Selkies 走离开路径完成释放，并拒绝发放租约。

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

打开 `/mgmt` 查看 Runtime 状态与版本、创建或校验 DSH_HOME 备份、管理账户和交接浏览器。创建备份和校验要求五分钟内验证过身份。升级、回滚、恢复以及迁移前的备份，请在停服后执行。[Runtime 维护](../README.zh-CN.md#升级与回滚)

### Traefik

- 若需要重建 Traefik，在它自己的 Compose 中把两张工作台网声明为外部网络。
- 若 Traefik 在代理网上的 IP 变化，以相同域名、HTTPS 入口和 resolver 重跑初始化，然后运行 `docker compose --env-file .env.public up -d --no-build gateway` 更新信任地址。

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

这组步骤也适用于从六容器 Gateway 候选版迁移。

1. 用 `bash deploy/public/images.sh` 确认目标版本能解析两个镜像摘要。停服备份 `auth-data` 卷和 `.workstation/`。用原来的 Compose 文件和项目名执行 `docker compose --env-file .env.public down`，保留命名卷。这会先释放旧 Provider 的固定地址，供 Gateway 使用。
2. 在原部署中切换到目标版本，沿用域名、状态目录、代理网络及 Traefik 选项重跑带 `--release` 的初始化。用新生成的 `routes.yml` 替换 Traefik 工作台路由文件，使其指向 `dsh-workstation-gateway-edge`。
3. 使用 `up -d --no-build --wait` 启动。Gateway 会用原 `auth-key` 打开原 `auth-data` SQLite 卷。Browser 复用原 hostname 和配置卷，Provider 复用原状态卷。用已有账户测试登录、`/mgmt` 和完整部署的 `/browser/`。

旧 `AUTH_*` 会话设置继续生效，优先读取新的 `GATEWAY_*`。如需回退，先停止新栈，再用原提交的初始化脚本恢复旧镜像引用和路由。原 `dsh-workstation-auth` 镜像留在旧发行版中。

### 升级与回滚

升级前先备份，再切换到已记录目标摘要的部署提交。Compose 在启动时拉取新摘要。

```bash
# 将 deployment_ref 设为 images.env 已记录目标摘要的部署提交。
git switch --detach "$deployment_ref" &&
  bash deploy/public/images.sh &&
  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release &&
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 420
```

按第 4 步安装重新生成的路由。回滚时，用旧部署提交重复此流程。

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
