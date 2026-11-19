# 私有预览

[English](README.md) · 简体中文

预览面向可信宿主机上的一位可信用户，需要 Docker Engine 28 或更新版本及 Compose v2。官方 DSH Web 位于 `http://127.0.0.1:3080/`，人工操作的 Selkies 位于 `/browser/`。只有 Traefik 发布端口，且仅监听宿主机回环地址。从其他机器访问须使用 SSH。需要直接公网访问时，使用[带认证和 HTTPS 的公网 Compose](public/README.zh-CN.md)。

在 GitHub Actions 的 [M1 private preview](../.github/workflows/m1-preview.yml) 构建和验证预览。运行器执行 `bash deploy/ci-preview.sh`，测试实际 Compose 路由、Runtime 版本选择和回滚、容器重建。可以从[通过的 `fe91e89` 运行](https://github.com/sagehou/dsh-workstation/actions/runs/44474103563/artifacts/14505771617)下载 `dsh-workstation-runtime.tar.gz`，也可以使用自己审阅的提交所生成的通过产物。

在部署主机上使用与产物同一提交下的 Compose 和 Traefik 文件：

```sh
docker load -i dsh-workstation-runtime.tar.gz
docker compose -f compose.preview.yml up -d --no-build --wait --wait-timeout 360
```

首次启动时，Runtime 会把精确版本的官方 DSH npm 包（默认 `0.2.2-rc.1`）下载到 DSH_HOME 命名卷。镜像中不包含 DSH 安装包。后续启动沿用已保存的版本选择。`DSH_INITIAL_VERSION` 只影响新卷的首次启动。

在自己的工作电脑上建立 SSH 隧道：

```sh
ssh -N -L 127.0.0.1:3080:127.0.0.1:3080 user@host
```

另开一个只供自己使用的部署主机终端，取得官方启动 URL：

```sh
docker compose -f compose.preview.yml exec -T runtime dsh-runtime launch-url
```

在桌面浏览器中打开该 URL 一次，获取 DSH 会话 Cookie。请保密；Runtime 重启后要重新获取启动 URL。浏览器桌面位于 `http://127.0.0.1:3080/browser/`。预览不发布 CDP，也不启用 Agent 浏览器工具。

## 升级与回滚

```sh
preview() { docker compose -f compose.preview.yml "$@"; }
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance versions
preview stop runtime
preview run --rm --no-deps maintenance install 0.2.2-rc.5
preview run --rm --no-deps maintenance select 0.2.2-rc.5
preview up -d --no-build --wait --wait-timeout 360 runtime
```

Web 提供服务时，版本管理器会锁住维护操作。它先在已停止的 DSH_HOME 副本中验证候选版本，再备份实际状态并原子替换版本选择。候选版本就绪检查失败时，保留当前选择。如果选定版本无法在实际数据上启动，先停止 Runtime，再用 `preview run --rm --no-deps maintenance rollback` 回滚，然后重启。Runtime 回滚无法撤销 DSH 数据迁移。

DSH_HOME、工作区、Chromium 配置目录和备份分别使用独立的命名卷。`preview down` 会保留这些卷。修改插件依赖或升级前，执行离线命令 `preview run --rm --no-deps maintenance backup`，把快照安全地保存到其他主机。Runtime 快照包含 DSH 状态及凭据，不包含可重新安装的 Runtime 包。工作区和 Chromium 配置目录要在使用它们的服务停止后分别备份。
