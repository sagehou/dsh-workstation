# 公网 Compose

[English](README.md) · 简体中文

[部署](#部署) · [使用浏览器](#使用浏览器) · [维护](#维护) · [备份与恢复](#备份与恢复)

## 部署前准备

- **主机**需要 Linux amd64、以 root 运行的 Docker Engine 28+ 和 Compose v2。用有 Docker 权限的非 root 用户执行，并先登录 GitHub CLI。
- **DNS** 将工作台域名指向 Traefik 所在主机。Traefik 提供公网端口 80 和 443，并管理证书。
- **Traefik** 须已在同一台 Docker 主机运行。确认它所在的可信 Docker 网络、HTTPS 入口、证书 resolver，以及 file provider 监视的宿主机目录。**不需要升级 Traefik**：CI 按摘要固定 `v3.7.14` 与 `v3.7.19`，并用同一套全栈测试覆盖两者；哪些版本已有通过记录见[兼容性矩阵](../../docs/roadmap/public-compose.zh-CN.md#traefik-兼容性矩阵)。
- **Docker 网络**确认两个 Compose 子网与宿主机路由没有重叠。[Compose](../../compose.yml)

## 部署

在部署主机的同一个终端按顺序执行。

### 1. 加载已验证的镜像

```bash
gh repo clone sagehou/dsh-workstation && cd dsh-workstation

images_dir="$(mktemp -d)"
release_commit='333e6f332ad054723ca32c8b9436c8109bb62ad4'
gh run download 44688814854 --repo sagehou/dsh-workstation \
  --name public-compose-linux-amd64 --dir "$images_dir" &&
  test "$(cat "$images_dir/source-commit")" = "$release_commit" &&
  git switch --detach "$release_commit" &&
  (
    cd "$images_dir" &&
    sha256sum -c workstation-images-linux-amd64.sha256 &&
    docker load -i workstation-images-linux-amd64.tar.gz
  )
```

[镜像包](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)

### 2. 配置域名和 Traefik

替换下方示例值。初始化脚本会记录 Traefik 在所选网络的 IPv4，并生成路由文件。HTTPS 入口已提供证书时，将 `WORKSTATION_TRAEFIK_RESOLVER` 设为空。

```bash
domain='workstation.example.net'
proxy='proxy'
traefik='traefik'
traefik_dynamic='/srv/traefik/dynamic'

WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
  bash deploy/public/init.sh "$domain" "$proxy" "$traefik"
```

### 3. 创建管理员

```bash
docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
```

1. 设置密码。
2. 将显示的 TOTP 密钥添加到验证器，输入当前验证码。
3. 离线保存显示的恢复码。创建首个账号后，初始化功能关闭。

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
| 让 Agent 使用标签页 | 在 `/_auth/control` 选择在线 DSH 会话，授予最长 120 秒的租约。授权前松开鼠标和键盘。第一次授权会创建标签页，此在线会话后续复用。 |
| 接管浏览器 | 选择 **接管浏览器**。Provider 停止接收新调用，等待当前操作结束后交还控制。 |
| 指定 Agent 可用的网站 | 在 `.env.public` 中设置 `BROWSER_TOOL_ORIGINS`，填逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`，再重建 Provider。留空时只允许人工浏览。 |

Agent 先用 `mcp__browser__lease_status` 获取代次，再调用 `navigate`、`read` 或 `click`。白名单约束这些工具和返回的页面文本。Chromium 仍会处理页面脚本和重定向，且标签页共享 Cookie。请使用可信来源。

连接或标签页丢失时，新建 DSH 会话并重新授权。要继续原来的对话，重启 Runtime、恢复对话，再给新连接授权。新标签页使用同一份 Chromium 配置。

## 维护

### Traefik

- 若需要重建 Traefik，在它自己的 Compose 中把两张工作台网声明为外部网络。
- 若 Traefik 在代理网上的 IP 变化，以相同域名、HTTPS 入口和 resolver 重跑初始化，然后运行 `docker compose --env-file .env.public up -d --no-build auth` 更新信任地址。

### 浏览器恢复

如果 Provider 无法确认进行中的浏览器操作已经结束，它会拒绝给该 Chromium 进程再授权。可重建 Chromium 和中继，并保留浏览器配置卷和配置中的 hostname。

```bash
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

Provider 会尝试自动重连。如果 Chromium 已就绪而控制页仍显示 `DISCONNECTED`，选择 **连接浏览器**。

### 账户与会话

| `.env.public` 配置项 | 默认值 |
| --- | --- |
| `AUTH_IDLE` | 30 分钟 |
| `AUTH_ABSOLUTE` | 12 小时 |
| `AUTH_MAX_SESSIONS` | 8 个 |

- HTTP 请求和新的 WebSocket 握手会刷新空闲计时。已建立的 DSH 和 Selkies WebSocket 每两秒检查会话，过期或被撤销后关闭。
- 在 `/_auth/account` 撤销单个或所有会话。密码登录后若超过五分钟，修改敏感设置前需要重新验证密码和 TOTP。
- 在宿主机停用或启用账号时，把管理员命令中的 `bootstrap admin` 替换为 `disable` 或 `enable`。两者都会使当前会话失效。

### DSH 版本

Runtime 首次启动时安装官方 DSH `0.2.2-rc.1`。官方 Plugin Manager 把 Workstation Bundle 安装到持久化 Web Profile。Runtime 和 Profile 安装均禁用包生命周期脚本。Bundle 使用已验证的 DSH 版本。

更改 Profile 或版本前备份 DSH_HOME。对公网 Compose 执行维护命令时使用 `--env-file .env.public`。版本回滚只切换 npm 安装，已迁移的数据需要从匹配的备份还原。[Runtime 维护命令](../README.zh-CN.md#升级与回滚)

### 从原有独立部署迁移

1. 在旧提交中执行 `down`。保留命名卷、`.env.public` 与 `.workstation/`。
2. 加载新镜像，并以相同域名重跑初始化。
3. 跳过管理员初始化，启动新 Compose。

旧容器的 hostname 如果留下浏览器配置锁，应先确认旧 Chromium 已停止，再清理配置卷 `/config/chromium` 下的 `SingletonLock`、`SingletonSocket` 和 `SingletonCookie` 符号链接。[Chromium 配置锁实现](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

### 镜像包过期

在 GitHub Actions 针对目标提交运行 **Public Compose**。把第 1 步的运行号和 `source-commit` 换成成功运行的值。矩阵中每条腿各自上传 artifact：默认版本保留不带后缀的 `public-compose-linux-amd64`，其余腿加 `-<版本>` 后缀。任选一条腿即可，工作台镜像在各腿之间相同，差异只在入口代理版本。[工作流](../../.github/workflows/public-compose.yml)

## 备份与恢复

| 保留内容 | 用途 |
| --- | --- |
| `.workstation/`，与 SQLite 分开备份 | TOTP 加密密钥、服务凭据和内部 TLS 密钥。重新安装时沿用原目录。 |
| `dsh-home`、`workspace`、`browser-profile`、`auth-data`、`provider-state` 命名卷 | DSH、浏览器、认证和 Provider 状态。停止 Compose 后做快照，保留数据时避免使用 `down -v`。 |

备份 Auth 时，将已停止的卷归档到私有位置。

```bash
docker compose --env-file .env.public stop && (
  umask 077
  docker run --rm --network none --user 0:0 --entrypoint tar \
    -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.2.0 \
    --numeric-owner -C /data -cf - . > auth-data.tar
)
```

停止工作台后，将备份还原到空的 `auth-data` 卷。使用匹配的 `.workstation/secrets/auth-key`，保留归档中的数字 UID/GID 和权限，保留 Passkey 使用的公网域名。Runtime 会重新生成启动 URL。

只有 Traefik 发布端口。桌面在独立标签页打开。原生侧栏与交接时释放已按住输入由 [#1](https://github.com/sagehou/dsh-workstation/issues/1) 追踪。[测试证据](../../docs/roadmap/public-compose.zh-CN.md)
