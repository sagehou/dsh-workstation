# 私有预览

[English](README.md) · 简体中文

供可信宿主机上的一位可信用户使用。需要 Docker Engine 28+ 和 Compose v2。Traefik 只在宿主机回环地址发布端口 3080，浏览器供人工操作。使用公网域名时，选用[带认证和 HTTPS 的公网部署](public/README.zh-CN.md)。

## 1. 加载镜像并启动

从已通过的 `fe91e89` 运行下载 `dsh-workstation-runtime.tar.gz`，也可使用自行审阅的提交所生成的通过产物。使用与镜像同一提交的 Compose 和 Traefik 文件。[已验证的镜像](https://github.com/sagehou/dsh-workstation/actions/runs/44474103563/artifacts/14505771617)

```sh
docker load -i dsh-workstation-runtime.tar.gz
docker compose -f compose.preview.yml up -d --no-build --wait --wait-timeout 360
```

新建的 DSH_HOME 卷默认安装官方 DSH `0.2.2-rc.1`，镜像提供运行环境。`DSH_INITIAL_VERSION` 只影响新卷，现有卷沿用已选版本。

## 2. 通过 SSH 访问

在工作电脑上建立到部署主机的隧道。

```sh
ssh -N -L 127.0.0.1:3080:127.0.0.1:3080 user@host
```

另开一个部署主机的私有终端，获取官方启动 URL。

```sh
docker compose -f compose.preview.yml exec -T runtime dsh-runtime launch-url
```

| 打开 | 用途 |
| --- | --- |
| 官方启动 URL | 获取 DSH 会话 Cookie。请保密，Runtime 重启后重新获取。 |
| `http://127.0.0.1:3080/browser/` | 通过 Selkies 操作 Chromium 桌面。 |

预览不发布 CDP。需要 Agent 浏览器工具时，使用公网部署。

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

维护时先停止 Runtime。选择版本会在 DSH_HOME 副本上验证候选版本。验证通过后备份实际状态并原子切换。就绪检查失败时沿用旧版本。

如果新版本在实际数据上无法启动，回滚后重启。

```sh
preview stop runtime
preview run --rm --no-deps maintenance rollback
preview up -d --no-build --wait --wait-timeout 360 runtime
```

已经迁移的数据需要从对应备份恢复。

## 备份

修改插件依赖或版本之前，先停止 Runtime 并创建快照。

```sh
preview stop runtime
preview run --rm --no-deps maintenance backup
```

将快照安全保存在其他主机。快照含凭据和 DSH 状态，可重新安装的 Runtime 包无需归档。工作区和 Chromium 配置卷要在相应服务停止后分别备份。`preview down` 保留 DSH_HOME、工作区、浏览器配置和备份命名卷。

GitHub Actions 运行 `bash deploy/ci-preview.sh`，检查路由、版本切换和回滚，以及重建容器后的数据。[工作流](../.github/workflows/m1-preview.yml) · [验证结果](../docs/roadmap/M1.zh-CN.md)
