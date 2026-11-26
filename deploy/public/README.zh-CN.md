# 公网 Compose

[English](README.md) · 简体中文

[网络地址](#网络地址) · [部署](#部署) · [使用浏览器](#使用浏览器) · [维护](#维护) · [备份与恢复](#备份与恢复)

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
| `WORKSTATION_SUBNET` | `172.30.241.0/24` | 内部网络上的 Runtime、Provider 和 Gateway。 |
| `BROWSER_SUBNET` | `172.30.233.0/24` | Chromium 与 Provider 的控制监听地址。 |

固定地址由子网推导：工作站网络上的 `.2` 给 Runtime、浏览器网络上的 `.2` 给 Provider，`.3` 是工作站网络上的 Provider。动态分配限制在每个子网的上半段，因此先启动的容器不可能占用固定地址。

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
  bash deploy/public/init.sh <域名> <代理网络> <Traefik 容器>
```

Runtime 证书按推导出的地址签发，因此在已有状态目录上用不同子网重跑初始化会被拒绝，而不是静默重签所有服务都信任的内部 CA。`--reissue` 才是有意为之的路径：它替换 CA 与 Runtime 证书，保留其他密钥，并要求重建容器以取得新地址。

## 部署

在部署主机的同一个终端按顺序执行。

### 1. 检出发布版本并确认固定镜像

本仓库自建的四镜像以**公开**包发布在 GHCR，因此部署主机不需要 `docker login`，也不需要在主机上保存任何凭据。

`deploy/public/images.env` 记录每个镜像的 manifest list 摘要，`deploy/public/images.sh` 把摘要解析成 `name:version@sha256:...`，摘要缺失时直接失败——这条路径无法产生浮动标签。

```bash
gh repo clone sagehou/dsh-workstation && cd dsh-workstation
release_tag='v0.2.0'
git switch --detach "$release_tag"

# 打印本次发布部署的引用，每行都必须以 @sha256: 结尾。
bash deploy/public/images.sh
```

如需核实摘要仍指向同一镜像，把它与仓库报告的摘要比对，必须完全一致：

```bash
docker buildx imagetools inspect ghcr.io/sagehou/dsh-workstation-runtime:0.2.1 \
  --format '{{json .Manifest.Digest}}'
```

拉取发生在 Compose 启动时：第 2 步之后 `.env.public` 中每个镜像都已按摘要引用。构建来源与 SBOM 附着在这些摘要上，因此随镜像一起保留，而不依赖某次工作流运行是否还在。

> 只有标签没有摘要属于可变引用，初始化脚本永远不会写入。若确实要从源码临时构建，第 2 步去掉 `--release`，由 Compose 在本地构建——两种模式都是显式选择。

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

`--release` 让初始化脚本解析已发布摘要，并写入 `.env.public` 的 `WORKSTATION_RUNTIME_IMAGE`、`WORKSTATION_GATEWAY_IMAGE`、`WORKSTATION_PROVIDER_IMAGE`、`WORKSTATION_GATE_IMAGE`。不加时，同样的键会写成本地构建标签。两种情况都明确了实际运行的是什么，且重跑初始化会替换这些键，而不是追加第二份。

#### 已有部署

在此变更之前子网写死在 `compose.yml` 中，因此已有的 `.env.public` 没有 `WORKSTATION_SUBNET` 与 `BROWSER_SUBNET`。默认值就是原来的地址，所以不带覆盖地重跑初始化不会动到现有证书，只会补写推导出的键：

```bash
WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$域名" "$代理网络" "$Traefik 容器" --release
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
```

不会重签任何证书，也不会用不同地址重建容器。镜像会变化：原先用本地归档加载的部署，会在下一次 `up` 时切换到按摘要固定的 GHCR 引用。若确实要换地址，那是一次迁移：先备份，用 `--reissue` 重跑，重建所有服务，并把 Traefik 重新连接到（重建后的）`dsh-workstation_workstation` 与 `dsh-workstation_browser` 网络。

### 3. 创建管理员

```bash
docker compose --env-file .env.public run --rm --no-deps gateway-admin bootstrap admin
```

1. 设置密码。
2. 将显示的 TOTP 密钥添加到验证器，输入当前验证码。
3. 离线保存显示的恢复码。创建首个账号后，初始化功能关闭。

## 选择部署形态

两种形态共用同一份 `compose.yml`。在第 3 步之前选定一种。

| 形态 | 服务 | 何时使用 |
| --- | --- | --- |
| **full**（默认） | `gateway`、`runtime`、`browser-gate`、`chromium`、`cdp-relay`、`provider` | 需要共享浏览器：操作者的 `/browser/` 页面，或 Agent 浏览器工具。 |
| **core** | `gateway`、`runtime` | 主机承载不了浏览器栈，或 Agent 浏览器控制尚未获批。 |

`core` 是明确的取舍，不是等价替代。它**没有 `/browser/` 页面，也没有 Agent 浏览器工具**。DSH 本身——聊天、会话、终端、插件、文件编辑——不受影响，因为这些由 Runtime 提供，而不是 Chromium。

### 浏览器栈为什么贵

`chromium` 预留 `shm_size: 1gb`（`compose.yml:162`），那是 tmpfs，直接占用宿主机内存。再加上 Chromium 进程树、Selkies、Provider 和输入门禁，浏览器栈在编码视频流时约占 2 GiB 常驻内存和 1–2 个核。2 GiB 主机无法与其他服务一并承载。

### 运行 core

```bash
docker compose --env-file .env.public \
  -f compose.yml -f deploy/public/compose.core.yml \
  up -d --no-build --wait --wait-timeout 420
```

覆盖文件将浏览器服务放入 `browser` profile。`WORKSTATION_BROWSER_MCP=0` 跳过安装浏览器 Bundle，`GATEWAY_BROWSER_ENABLED=0` 让 `/browser/` 和 `/_auth/browser` 返回 503。

本指南后续每一条 `compose` 命令都要带同一对 `-f`，包括 `down`、`logs` 和 `run`。core 部署之后再执行不带覆盖文件的 `docker compose up`，会试图在承载不了的主机上启动完整栈。

### core 没有验证什么

CI 的 `core-shape` 只证明 `gateway` 与 `runtime` 能启动、浏览器 Bundle 未安装、以及 `/browser/` 经由 core 路径拒绝。它不证明完整栈在你的主机上可用，也不能替代 `full` 的各条 leg。**两种形态都未在 2 GiB 机器上运行过**；上面的内存数字是依据配置限制的估算，不是实测。

### 4. 启动 Compose 并添加路由

Traefik 对每张工作台网络只需接入一次。把生成的路由文件放进 Traefik 监视的宿主机目录。

```bash
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360 &&
  docker network connect dsh-workstation_workstation "$traefik" &&
  docker network connect dsh-workstation_browser "$traefik" &&
  install -m 0644 .workstation/edge/routes.yml "$traefik_dynamic/.dsh-workstation.tmp" &&
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml" &&
  docker compose --env-file .env.public ps
```

### 5. 登录

1. 打开 `https://<域名>/`。
2. 使用 `admin`、密码和新的 TOTP 验证码登录。绑定时的验证码已使用。
3. 在 DSH 的 **Settings → Models** 填入 DeepSeek API Key。
4. 如需使用 Passkey，在 `/_auth/account` 注册，即可使用独立的 Passkey 登录。

## 使用浏览器

> **首版发布门槛：** 首版正式浏览器入口是独立浏览器/控制页面。 [#4](https://github.com/sagehou/dsh-workstation/issues/4) 的已按住输入释放和独占交接验收通过前，不得在生产环境开放 Agent 浏览器控制。[#11](https://github.com/sagehou/dsh-workstation/issues/11) 的独立出口策略测试通过前，不得开放 Agent 广泛访问不可信网站。仅配置 `BROWSER_TOOL_ORIGINS` 不构成网络出口防火墙或完整 SSRF 防护。


| 要做什么 | 在哪里操作 |
| --- | --- |
| 打开共享 Chromium | 从 `/_auth/browser` 打开同源的 `/browser/`，沿用工作台登录。 |
| 让 Agent 使用标签页 | Agent 可以通过 `lease_status` 取得空闲租约，也可以在 `/mgmt/browser` 手动授予最长 120 秒的租约。`browser-gate` 确认已按住的输入释放后，才会移交控制权。 |
| 接管浏览器 | 选择 **接管浏览器**。Provider 停止接收新调用，等待当前操作结束后交还控制。 |
| 指定 Agent 可用的网站 | 在 `.env.public` 中设置 `BROWSER_TOOL_ORIGINS`，填逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`，再重建 Provider。 |

Agent 先用 `mcp__browser__lease_status` 获取代次，再调用 `navigate`、`read` 或 `click`。其他 DSH 会话的工具调用无法改变这份租约。配置来源白名单后，它会约束这些工具和返回的页面文本。Chromium 仍会处理页面脚本和重定向，且标签页共享 Cookie。请使用可信来源。

连接或标签页丢失时，新建 DSH 会话并重新授权。要继续原来的对话，重启 Runtime、恢复对话，再给新连接授权。新标签页使用同一份 Chromium 配置。

### 输入门禁

`browser-gate` 位于登录代理与 Chromium 数据连接之间，是唯一承载输入的路径。已固定的 Selkies 会在每个帧上按实时令牌表判定输入权限，并且**先**安装新表**再**通告变更，因此权限收回之后发出的释放帧会被丢弃。这就是交接时按住的鼠标键此前会在整个 Agent 租约期间保持按下的原因。门禁会在 Provider 接管权限**之前**，用 Selkies 自带的 `reset_keyboard()` 与 `release_mouse_buttons()` 原语释放已按住输入，并等待上游确认这些帧。若无法证明，它会在该连接仍持有权限时关闭它，让 Selkies 走离开路径完成释放，并拒绝发放租约。

不碰浏览器即可检查：

```sh
docker compose exec -T provider node --input-type=module -e '
  const s = require("node:fs").readFileSync("/run/secrets/gate_control", "utf8").trim()
  const r = await fetch("http://dsh-workstation-browser-gate:8082/status", {
    headers: { Authorization: "Bearer " + s },
  })
  console.log(await r.json())
'
```

只有在你持有权限时 `state` 才是 `OPEN`，交接正在证明释放期间为 `RELEASING`。`POST /handover` 只有在上游确认释放后才返回 `released: true`。[ADR-0005](../adr/0005-release-held-input-at-selkies.zh-CN.md) 记录了顺序依据。

## 维护

打开 `/mgmt` 查看 Runtime 状态与版本、创建或校验 DSH_HOME 备份、管理账户和交接浏览器。创建备份和校验要求五分钟内验证过身份。升级、回滚、恢复以及迁移前的备份，请在停服后执行。[Runtime 维护](../README.zh-CN.md#升级与回滚)

### Traefik

- 若需要重建 Traefik，在它自己的 Compose 中把两张工作台网声明为外部网络。
- 若 Traefik 在代理网上的 IP 变化，以相同域名、HTTPS 入口和 resolver 重跑初始化，然后运行 `docker compose --env-file .env.public up -d --no-build gateway` 更新信任地址。

### 浏览器恢复

如果 Provider 无法确认进行中的浏览器操作已经结束，它会拒绝给该 Chromium 进程再授权。可重建 Chromium 和中继，并保留浏览器配置卷和配置中的 hostname。

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
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

Runtime 首次启动时安装官方 DSH `0.2.2-rc.1`。官方 Plugin Manager 把 Workstation Bundle 安装到持久化 Web Profile。Runtime 和 Profile 安装均禁用包生命周期脚本。Bundle 使用已验证的 DSH 版本。

更改 Profile 或版本前备份 DSH_HOME。对公网 Compose 执行维护命令时使用 `--env-file .env.public`。版本回滚只切换 npm 安装，已迁移的数据需要从匹配的备份还原。[Runtime 维护命令](../README.zh-CN.md#升级与回滚)

### 从原有独立部署迁移

1. 在旧提交中执行 `down`。保留命名卷、`.env.public` 与 `.workstation/`。
2. 以相同域名重跑初始化（`--release` 会把镜像切换到按摘要固定的 GHCR 引用）。
3. 跳过管理员初始化，启动新 Compose。

旧容器的 hostname 如果留下浏览器配置锁，应先确认旧 Chromium 已停止，再清理配置卷 `/config/chromium` 下的 `SingletonLock`、`SingletonSocket` 和 `SingletonCookie` 符号链接。[Chromium 配置锁实现](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### 从 auth 迁移到 Gateway

1. 用 `bash deploy/public/images.sh` 确认目标版本能解析全部四个镜像摘要。停服备份 `auth-data` 卷和 `.workstation/`。用原来的 Compose 文件和项目名执行 `docker compose --env-file .env.public down`，省略 `-v`。
2. 在原部署中切换到目标版本，沿用域名、状态目录、代理网络及 Traefik 选项重跑带 `--release` 的初始化。用新生成的 `routes.yml` 替换 Traefik 工作台路由文件，使其指向 `dsh-workstation-gateway-edge`。
3. 使用 `up -d --no-build --wait` 启动。Gateway 会用原 `auth-key` 打开原 `auth-data` SQLite 卷。用已有账户测试登录、`/mgmt` 和完整部署的 `/browser/`。

旧 `AUTH_*` 会话设置继续生效，优先读取新的 `GATEWAY_*`。如需回退，先停止新栈，再用原提交的初始化脚本恢复旧镜像引用和路由。原 `dsh-workstation-auth` 镜像留在旧发行版中。

### 升级与回滚

升级就是更换摘要。先备份，再切换引用并重建受影响的服务；Compose 会在 `up` 时拉取新摘要：

```bash
git switch --detach v0.3.0
WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik" --release
docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
```

回滚是同样的操作换成旧标签：检出 `v0.2.0`、重跑初始化恢复旧摘要、再次 `up`。由于引用是摘要，旧镜像仍恰好是该标签当时发布的内容——上游标签不可能在你脚下移动。

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
    -v dsh-workstation_auth-data:/data:ro "$WORKSTATION_PROVIDER_IMAGE" \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

停止工作台后，将备份还原到空的 `auth-data` 卷。使用匹配的 `.workstation/secrets/auth-key`，保留归档中的数字 UID/GID 和权限，保留 Passkey 使用的公网域名。Runtime 会重新生成启动 URL。

只有 Traefik 发布端口。桌面在独立标签页打开。原生侧栏与交接时释放已按住输入由 [#1](https://github.com/sagehou/dsh-workstation/issues/1) 追踪。[测试证据](../../docs/roadmap/public-compose.zh-CN.md)
