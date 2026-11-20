# 公网 Compose

[English](README.md) · 简体中文

本部署面向一位可信用户，需要 Linux x86-64、以 root 运行的 Docker Engine 28 或更新版本，以及 Compose v2。同一 Docker 主机上须有一个正在运行的 Traefik 容器，已配置 HTTPS 入口和监视目录的 file provider。GitHub Actions 使用 Traefik `3.7.19`。Traefik 继续提供 80 和 443 端口并管理公网证书。把域名指向该 Traefik 主机，并确认 [compose.yml](../../compose.yml) 中的两个子网没有被宿主机占用。

以有 Docker 权限的非 root 用户执行。先登录有仓库访问权限的 GitHub CLI。替换域名、Traefik 所在的可信 Docker 网络、容器名和 file provider 监视的宿主机目录。HTTPS 入口和证书 resolver 要用 Traefik 现有的名字。若入口已提供证书，把 `WORKSTATION_TRAEFIK_RESOLVER` 设为空。初始化脚本读取所选网桥上的 Traefik IPv4，Go Auth 只信任这个地址。[GitHub Actions 产物](https://github.com/sagehou/dsh-workstation/actions/runs/44688814854/artifacts/14607841816)提供匹配下面源码提交的镜像。

```bash
(
  set -e
  domain='workstation.example.net'
  proxy='proxy'
  traefik='traefik'
  traefik_dynamic='/srv/traefik/dynamic'

  gh repo clone sagehou/dsh-workstation
  cd dsh-workstation

  images_dir="$(mktemp -d)"
  gh run download 44688814854 --repo sagehou/dsh-workstation \
    --name public-compose-linux-amd64 --dir "$images_dir"
  release_commit='333e6f332ad054723ca32c8b9436c8109bb62ad4'
  test "$(cat "$images_dir/source-commit")" = "$release_commit"
  git switch --detach "$release_commit"
  (
    cd "$images_dir"
    sha256sum -c workstation-images-linux-amd64.sha256
    docker load -i workstation-images-linux-amd64.tar.gz
  )

  WORKSTATION_TRAEFIK_ENTRYPOINT=websecure WORKSTATION_TRAEFIK_RESOLVER=letsencrypt \
    bash deploy/public/init.sh "$domain" "$proxy" "$traefik"

  docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
  docker network connect dsh-workstation_workstation "$traefik"
  docker network connect dsh-workstation_browser "$traefik"
  install -m 0644 .workstation/edge/routes.yml "$traefik_dynamic/.dsh-workstation.tmp"
  mv "$traefik_dynamic/.dsh-workstation.tmp" "$traefik_dynamic/dsh-workstation.yml"
  docker compose --env-file .env.public ps
)
```

如果常重建 Traefik，把工作台的两个网络作为外部网络写进 Traefik 自己的 Compose。如果 Traefik 在代理网的 IP 变了，用相同域名和参数重跑 `init.sh`，然后执行 `docker compose --env-file .env.public up -d --no-build auth` 更新信任地址。重跑时沿用已有 HTTPS 入口和证书 resolver 设置。

已有部署切换前，先在旧提交用 Compose 的 `down` 停止服务。保留 `.env.public`、`.workstation/` 和命名卷，切换后以相同域名重新初始化，跳过管理员初始化。DSH 和 Chromium 数据仍使用原有卷。 如果旧容器的 hostname 在浏览器配置卷里留下了锁，先确认旧 Chromium 已停止，再清理卷内 `/config/chromium` 的 `SingletonLock`、`SingletonSocket` 和 `SingletonCookie` 三个符号链接，然后启动新容器。[Chromium 配置锁实现](https://github.com/chromium/chromium/blob/156.0.8078.79/chrome/browser/process_singleton_posix.cc)

镜像包到期后，可对所需版本运行 [Public Compose](../../.github/workflows/public-compose.yml)，再使用通过的运行号和匹配的 `source-commit`。

初始化会要求设置密码，并显示 TOTP 绑定密钥。在验证器里绑定后输入当前验证码，并离线保存终端打印的恢复码。第一个账号创建后，初始化命令即停用。绑定时用过的验证码不能用于登录，请等待验证器刷新后再打开 `https://<域名>/` 登录。到官方 DSH 的 **Settings → Models** 填入 DeepSeek API Key。登录与凭据管理在 `/_auth/account`；注册 Passkey 后可用独立的 Passkey 登录流程。密码验证后有五分钟的敏感操作窗口，超时后修改安全设置须重新完成两步登录。

Runtime 首次启动时会安装官方 DSH `0.2.2-rc.1`，并通过官方 Plugin Manager 把 Workstation Bundle 安装到持久化的 Web Profile。Runtime 和 Profile 安装均禁用包生命周期脚本。Bundle 已针对这个 DSH 版本验证，在其他版本通过验证前保持固定版本。

桌面从 `/_auth/browser` 打开，视频流位于同源的 `/browser/`，工作台会传递桌面凭据，无需单独登录。在 `/_auth/control` 可向一个在线 DSH 会话授予最长 120 秒的租约。第一次授予时会在同一个 Chromium 配置目录下创建标签页，继续为那个在线会话授予租约会复用其标签页。授权前先松开鼠标按键和键盘。点击 **接管浏览器** 后，系统停止接收新的 Agent 调用，等待已经开始的调用结束，再把控制权交还人工。

在 `.env.public` 设置 `BROWSER_TOOL_ORIGINS`，填入逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`。修改后重建 Provider。列表为空时，Agent 的导航、读取和点击都会被拒绝。Agent 调用 `mcp__browser__lease_status` 取得当前代次，再调用 `navigate`、`read` 或 `click`。源白名单约束工具命令和返回的页面文本。Chromium 仍按正常方式处理网络、页面脚本和重定向，只应添加可信来源。各标签页共享 Cookie，整个工作台面向同一个使用者。

如果 Agent 连接或标签页丢失，可以新建 DSH 会话并重新授予租约。要继续原对话，可重启 Runtime、恢复对话，再重新授权。新连接会在同一个持久化 Chromium 配置目录下分配新标签页。如果 Provider 无法确认进行中的操作已经结束，就不会再向该 Chromium 进程授予租约。可同时重建 Chromium 和中继，保留浏览器配置卷和 Chromium hostname：

```sh
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

浏览器进程退出后，Provider 会尝试自动重新连接。如果 Chromium 已就绪但控制页仍显示 DISCONNECTED，点击 **连接浏览器**。

会话默认空闲超时 30 分钟，最长存活 12 小时，最多八个。可在 `.env.public` 设置 `AUTH_IDLE`、`AUTH_ABSOLUTE` 和 `AUTH_MAX_SESSIONS`。HTTP 请求及新的 WebSocket 握手会更新空闲计时。已经建立的 DSH 和 Selkies WebSocket 每两秒检查会话状态，并在会话过期或撤销后关闭。账户页可撤销一个或全部会话。部署人员也可使用初始化服务命令，把 `bootstrap admin` 替换为 `disable` 或 `enable` 来停用或重新启用账号，两者都会使现有会话失效。

将 `.workstation/` 与数据库分开备份，限制访问；运行中的部署不要重建它。目录中包含 TOTP 加密密钥、服务凭据和内部 TLS 密钥。恢复 Passkey 时保持公网域名不变。先停止工作台，再为命名卷做快照。保留 `dsh-home`、`workspace`、`browser-profile`、`auth-data` 和 `provider-state`。会话启动 URL 会重新生成。要保留部署数据，就不要运行 `down -v`。例如，执行 `docker compose --env-file .env.public stop` 后，可通过已部署的 Provider 镜像把 Auth 卷打包到私有目录：

```sh
umask 077
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.2.0 \
  --numeric-owner -C /data -cf - . > auth-data.tar
```

恢复时先停止工作台。使用对应的归档和 `.workstation/secrets/auth-key`，将数据还原到空的 `auth-data` 卷，保留归档中的数字 UID/GID 和权限。更改 Profile 或版本前先备份 DSH_HOME。使用 [Runtime 维护命令](../README.zh-CN.md#升级与回滚)时，将 Compose 参数改为公网 Compose 的 `--env-file .env.public`。Runtime 回滚只改变选中的 npm 安装；发生数据迁移后需要匹配的备份。

只有 Traefik 发布宿主机端口。交接时自动释放已按住的输入和原生 DSH 侧栏仍留待后续处理，当前可以在单独标签页使用浏览器。参见[验证结果和限制](../../docs/roadmap/public-compose.zh-CN.md)。
