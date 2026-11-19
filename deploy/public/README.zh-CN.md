# 公网 Compose

[English](README.md) · 简体中文

本部署面向一位可信用户，需要 Linux x86-64、以 root 运行的 Docker Engine 28 或更新版本及 Compose v2。将域名的 `A` 记录指向服务器公网 IPv4，在云安全组和主机防火墙放行入站 TCP 80、443。端口 80 用于 ACME HTTP-01 验证，其余请求重定向至 HTTPS。Traefik 负责签发和续期。若配置 `AAAA`，确保 IPv6 同样指向该主机并可访问这两个端口。[compose.yml](../../compose.yml) 中的 Docker 子网不能与宿主机的路由重叠。

在部署主机上，用有 Docker 权限的非 root 用户执行。先登录有仓库访问权的 GitHub CLI（`gh auth login`），将下方域名和邮箱换成实际值。命令会下载 [GitHub Actions 已验证的镜像包](https://github.com/sagehou/dsh-workstation/actions/runs/44488230831/artifacts/14512006785)，校验 SHA-256，并检出与镜像匹配的源码版本。

```bash
(
  set -e
  domain='workstation.example.net'
  acme_email='admin@example.net'

  gh repo clone sagehou/dsh-workstation
  cd dsh-workstation

  images_dir="$(mktemp -d)"
  gh run download 44488230831 --repo sagehou/dsh-workstation \
    --name public-compose-linux-amd64 --dir "$images_dir"
  release_commit='de823f9d850ae5a8bc001a67613413220ff4fd7e'
  test "$(cat "$images_dir/source-commit")" = "$release_commit"
  git switch --detach "$release_commit"
  (
    cd "$images_dir"
    sha256sum -c workstation-images-linux-amd64.sha256
    docker load -i workstation-images-linux-amd64.tar.gz
  )

  bash deploy/public/init.sh "$domain" "$acme_email"
)
```

若需 Agent 操作网页，在启动前编辑 `dsh-workstation/.env.public` 的 `BROWSER_TOOL_ORIGINS`，填入逗号分隔的 HTTPS 源，例如 `https://www.example.org,https://docs.example.com`。留空只允许人工浏览。若镜像包过期，在 GitHub Actions 对所需版本运行 [Public Compose 工作流](../../.github/workflows/public-compose.yml)，用新运行号和新产物的 `source-commit` 替换上面的值。

```bash
(
  set -e
  cd dsh-workstation
  docker compose --env-file .env.public run --rm --no-deps auth-admin bootstrap admin
  docker compose --env-file .env.public up -d --no-build --wait --wait-timeout 360
  docker compose --env-file .env.public ps
)
```

初始化会要求设置密码，并显示 TOTP 绑定密钥。在验证器里绑定后输入当前验证码，并离线保存终端打印的恢复码。第一个账号创建后，初始化命令即停用。绑定时用过的验证码不能用于登录，请等待验证器刷新后再打开 `https://<域名>/` 登录。到官方 DSH 的 **Settings → Models** 填入 DeepSeek API Key。登录与凭据管理在 `/_auth/account`；注册 Passkey 后可用独立的 Passkey 登录流程。密码验证后有五分钟的敏感操作窗口，超时后修改安全设置须重新完成两步登录。

Runtime 首次启动时会安装官方 DSH `0.2.2-rc.1`，并通过官方 Plugin Manager 把 Workstation Bundle 安装到持久化的 Web Profile。Runtime 和 Profile 安装均禁用包生命周期脚本。Bundle 已针对这个 DSH 版本验证，在其他版本通过验证前保持固定版本。

桌面从 `/_auth/browser` 打开，视频流位于同源的 `/browser/`，工作台会传递桌面凭据，无需单独登录。在 `/_auth/control` 可向一个在线 DSH 会话授予最长 120 秒的租约。第一次授予时会在同一个 Chromium 配置目录下创建标签页，继续为那个在线会话授予租约会复用其标签页。授权前先松开鼠标按键和键盘。点击 **接管浏览器** 后，系统停止接收新的 Agent 调用，等待已经开始的调用结束，再把控制权交还人工。

修改 `BROWSER_TOOL_ORIGINS` 后需要重建 Provider。列表为空时，Agent 的导航、读取和点击都会被拒绝。Agent 调用 `mcp__browser__lease_status` 取得当前代次，再调用 `navigate`、`read` 或 `click`。源白名单约束工具命令和返回的页面文本。Chromium 仍按正常方式处理网络、页面脚本和重定向，只应添加可信来源。各标签页共享 Cookie，整个工作台面向同一个使用者。

如果 Agent 连接或标签页丢失，可以新建 DSH 会话并重新授予租约。要继续原对话，可重启 Runtime、恢复对话，再重新授权。新连接会在同一个持久化 Chromium 配置目录下分配新标签页。如果 Provider 无法确认进行中的操作已经结束，就不会再向该 Chromium 进程授予租约。可同时重建 Chromium 和中继，保留浏览器配置卷：

```sh
docker compose --env-file .env.public up -d --no-build --force-recreate chromium cdp-relay
```

浏览器进程退出后，Provider 会尝试自动重新连接。如果 Chromium 已就绪但控制页仍显示 DISCONNECTED，点击 **连接浏览器**。

会话默认空闲超时 30 分钟，最长存活 12 小时，最多八个。可在 `.env.public` 设置 `AUTH_IDLE`、`AUTH_ABSOLUTE` 和 `AUTH_MAX_SESSIONS`。HTTP 请求及新的 WebSocket 握手会更新空闲计时。已经建立的 DSH 和 Selkies WebSocket 每两秒检查会话状态，并在会话过期或撤销后关闭。账户页可撤销一个或全部会话。部署人员也可使用初始化服务命令，把 `bootstrap admin` 替换为 `disable` 或 `enable` 来停用或重新启用账号，两者都会使现有会话失效。

将 `.workstation/` 与数据库分开备份，限制访问；运行中的部署不要重建它。目录中包含 TOTP 加密密钥、服务凭据、内部 TLS 密钥和 ACME 状态。恢复 Passkey 时保持公网域名不变。先停止工作台，再为命名卷做快照。保留 `dsh-home`、`workspace`、`browser-profile`、`auth-data` 和 `provider-state`。会话启动 URL 会重新生成。要保留部署数据，就不要运行 `down -v`。例如，执行 `docker compose --env-file .env.public stop` 后，可通过已部署的 Provider 镜像把 Auth 卷打包到私有目录：

```sh
umask 077
docker run --rm --network none --user 0:0 --entrypoint tar \
  -v dsh-workstation_auth-data:/data:ro dsh-workstation-provider:0.1.0 \
  --numeric-owner -C /data -cf - . > auth-data.tar
```

恢复时先停止工作台。使用对应的归档和 `.workstation/secrets/auth-key`，将数据还原到空的 `auth-data` 卷，保留归档中的数字 UID/GID 和权限。更改 Profile 或版本前先备份 DSH_HOME。使用 [Runtime 维护命令](../README.zh-CN.md#升级与回滚)时，将 Compose 参数改为公网 Compose 的 `--env-file .env.public`。Runtime 回滚只改变选中的 npm 安装；发生数据迁移后需要匹配的备份。

只有 Traefik 发布宿主机端口。交接时自动释放已按住的输入和原生 DSH 侧栏仍留待后续处理，当前可以在单独标签页使用浏览器。参见[验证结果和限制](../../docs/roadmap/public-compose.zh-CN.md)。
