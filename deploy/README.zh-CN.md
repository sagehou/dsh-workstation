# 私有预览

[English](README.md) · 简体中文

供可信宿主机上的一位可信用户使用。需要 Docker Engine 28+ 和 Compose v2。常驻服务为 `runtime`、`chromium` 和 Traefik（`edge`），共 3 个。Traefik 只在宿主机回环地址发布端口 3080，浏览器供人工操作。使用公网域名时，选用[带认证和 HTTPS 的公网部署](public/README.zh-CN.md)。

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

维护时先停止 Runtime。`upgrade` 是推荐路径，因为它会记录匹配的备份和审计记录；`select` 仍可用于显式手动切换。

```sh
preview() { docker compose -f compose.preview.yml "$@"; }
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance versions   # 列出可安装版本
preview stop runtime
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5
```

切换指针之前，`upgrade` 检查四项，任一项失败即停止：

| 检查 | 阻断原因 |
| --- | --- |
| 镜像 Node.js 与候选版本 `engines.node` | 拒绝 Node `24.22.3` 的候选版本无法启动。 |
| 已安装 Profile Bundle 与候选版本 | 声明 `engines.dsh` 的 Bundle 会锁定 DSH 版本。随镜像发布的浏览器 Bundle 声明 `0.2.2-rc.1`，因此只要它处于安装状态，DSH 就无法升级。 |
| 含生命周期脚本的 Profile 依赖 | 安装使用 `--ignore-scripts`，因此这类脚本从未执行。只可按精确的 `package@version` 批准。 |
| 候选版本在 DSH_HOME 副本上的就绪检查 | 启动和 Profile 激活必须在脱离实际数据的情况下成功。 |

被阻断的升级不改动活动指针和数据，候选版本保留在原版本旁边。批准指定包后重试：

```sh
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5   # 输出阻断的包
preview run --rm --no-deps maintenance approve native-thing@2.0.0
preview run --rm --no-deps maintenance upgrade 0.2.2-rc.5
```

批准记录在 `DSH_HOME/approved-scripts.txt`，因此对后续事务（包括回滚）同样生效。批准必须写明确切版本；范围或裸包名会被拒绝。

在新版本上重启后，记录本次升级是否迁移了 Profile 状态：

```sh
preview up -d --no-build --wait --wait-timeout 360 runtime
preview stop runtime
preview run --rm --no-deps maintenance verify
```

`verify` 将 Profile 清单、锁文件和已安装包版本与切换前记录的状态比较，输出 `unchanged` 或 `MIGRATED`。**指针回滚只改变可执行文件。** 状态已迁移时，应恢复匹配的备份。

```sh
preview run --rm --no-deps maintenance restore 20260101T120000Z.a1b2c3d4e5f6
preview up -d --no-build --wait --wait-timeout 360 runtime
```

恢复会拒绝校验和不符的归档、没有清单的备份，以及 DSH 版本尚未安装的备份——把数据恢复到它从未运行过的版本属于错配而非恢复。

## 备份

停止 Runtime 后创建快照。每次备份写入一个归档和一个清单，清单记录 Runtime 镜像、DSH 选择状态、归档校验和，以及 Runtime 自身文件的摘要。

归档只含可恢复状态：Profile、插件依赖、凭据和会话。它排除 `runtime`（已安装的 DSH 版本）和 `pnpm`（内容寻址存储），两者都可从 registry 重新安装。在真实安装上实测这两项分别为 962 MB 和 869 MB，会把 40 KB 的 Profile 备份变成 223 MB 归档。

```sh
preview stop runtime
preview run --rm --no-deps maintenance backup
preview run --rm --no-deps maintenance backups   # 列出 id、版本、时间、大小
```

将快照安全保存在其他主机。快照含凭据和 DSH 状态，可重新安装的 Runtime 包无需归档。工作区和 Chromium 配置卷要在相应服务停止后分别备份。`preview down` 保留 DSH_HOME、工作区、浏览器配置和备份命名卷。

## 恢复演练

首次安装后，以及每次更换 Runtime 镜像后，在部署主机上执行一次。它验证的是你实际依赖的数据，而不是合成样本。

```sh
preview() { docker compose -f compose.preview.yml "$@"; }

# 1. 先看将要备份的内容，以及哪个 Bundle 锁定了 DSH 版本。
preview exec -T runtime dsh-runtime status
preview run --rm --no-deps maintenance inspect

# 2. 创建匹配备份并记下 id。
preview stop runtime
preview run --rm --no-deps maintenance backup | tee /tmp/backup-id
preview run --rm --no-deps maintenance backups

# 3. 在不恢复的前提下证明归档和清单可用。
preview run --rm --no-deps maintenance check 20260101T120000Z.a1b2c3d4e5f6
```

然后演练事务可能出现的两种结果：

| 场景 | 执行 | 结果必须满足 |
| --- | --- | --- |
| 升级未改动 Profile 状态 | `verify` 输出 `unchanged`，再执行 `rollback` | 旧版本重新可用，数据与备份一致。 |
| 升级迁移了 Profile 状态 | `verify` 输出 `MIGRATED`，再执行 `restore <id>` | 旧版本重新可用，Profile 状态与升级前指纹一致。 |

```sh
# 演练 A：指针回滚。
preview run --rm --no-deps maintenance rollback
preview up -d --no-build --wait --wait-timeout 360 runtime
docker compose -f compose.preview.yml exec -T runtime dsh-runtime status

# 演练 B：匹配数据恢复。
preview stop runtime
preview run --rm --no-deps maintenance restore 20260101T120000Z.a1b2c3d4e5f6
preview up -d --no-build --wait --wait-timeout 360 runtime
```

恢复会替换 DSH_HOME 除 `runtime` 与 `pnpm` 之外的每个顶层条目，因此已安装版本、pnpm 存储和审计日志得以保留。若迁移涉及工作区、Chromium 配置或公网部署的 Gateway SQLite 卷，需要用各自的备份恢复。

把实际结果记入部署日志。`preview run --rm --no-deps maintenance audit` 输出事务轨迹（`start`、`switched`、`verified`、`pointer-rollback`、`restored`、`script-approved`），不含凭据。

`deploy/ci-upgrade.sh` 在 GitHub 托管运行器上演练同一路径：Bundle 锁定阻断切换、未批准的生命周期脚本、带清单的批准升级、合成迁移前后的 `verify`、保留迁移数据的指针回滚、匹配恢复、拒绝被篡改的归档和未知 id、重建容器，以及带恢复数据的 Runtime 镜像回滚。

GitHub Actions 运行 `bash deploy/ci-preview.sh` 检查路由和重建，`bash deploy/ci-upgrade.sh` 执行完整的升级与恢复演练，`node --test "runtime/test/*.test.mjs"` 验证兼容门禁与清单逻辑。[工作流](../.github/workflows/m1-preview.yml) · [验证结果](../docs/roadmap/M1.zh-CN.md)
