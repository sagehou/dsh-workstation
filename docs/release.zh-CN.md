# 发布镜像

[English](release.md) · 简体中文

本仓库自建的四镜像以**公开**包发布在 GHCR：`dsh-workstation-runtime`、
`dsh-workstation-auth`、`dsh-workstation-provider` 与
`dsh-workstation-browser-gate`（由 `browser-gate/` 构建）。

部署从不只引用标签。`deploy/public/images.env` 记录每个镜像的 manifest list
摘要，`deploy/public/images.sh` 把摘要解析成
`ghcr.io/sagehou/<名称>:<版本>@sha256:...`。摘要缺失即报错，因此该文件没有
任何路径可以产生浮动标签。

## 保障链条

| 性质 | 实现方式 |
| --- | --- |
| fork PR 无法发布 | 工作流没有 `pull_request` 触发器。只有 `push: tags` 与 `workflow_dispatch` 会运行，二者在 fork 中都无法触达。 |
| 不可信输入接触不到凭据 | `plan` 作业不持有任何仓库凭据，只读取受版本控制的镜像清单。`publish` 从 `plan` 接收矩阵，并用 `deploy/public/images.sh` 校验镜像名。 |
| 同一标签不能用不同内容重发 | 若 `images.env` 已记录该版本的摘要，发布不同摘要会失败，而不会覆盖部署可能正在使用的引用。 |
| 发布需审批 | `publish` 绑定 `ghcr-release` 环境。在其中配置必需审批人后，每次发布（包括打标签）都要人工批准。 |
| 构建来源随镜像保留 | `provenance: mode=max` 与 `sbom: true` 把证明附着到摘要上，而不是某次 Actions 运行。 |
| 发布用的标签就是部署读取的标签 | 工作流与初始化脚本的镜像名都来自同一个解析器。 |
| 无法部署 `latest` | 解析器只接受 `X.Y.Z`，且没有任何工作流产生 `latest` 标签。 |
| 镜像确实公开 | `record` 作业在不登录的情况下拉取每个已记录摘要。若包被误设为私有，该次运行会失败。 |

## 一次性配置（仓库管理员）

1. 在 **Settings → Environments** 创建 `ghcr-release` 环境，并至少添加一名必需审批人。未配置时，打标签后会立即发布。
2. 首次发布后，在包设置中确认每个包的可见性为 **Public**（公开仓库通常继承公开可见性，但由私有运行创建的包可能不是）。
3. 保护 `v*` 标签，使只有维护者能创建。

不需要任何仓库 secret：工作流使用自动的 `GITHUB_TOKEN`，仅在 `publish` 作业中
授予 `packages: write`。

## 发布步骤

1. 在 `deploy/public/images.env` 中为本次要变更的镜像提升版本号，并清空其摘要——摘要在发布时填入。各镜像版本独立：Runtime 镜像随 Node 或启动脚本变化，门禁镜像按自己的节奏变化。
2. 合并该变更。
3. 在 `main` 上运行 **Publish images**（`image: all`），或创建标签 `v<版本>`（例如 `v0.2.0`）来标记发布点。

   `v*` 标签标记的是**仓库**的发布点，不是共用的镜像版本。四个镜像版本独立，因此 `v0.2.0` 标签可能发布
   `runtime:0.2.0`、`auth:0.1.1`、`provider:0.2.0`、`browser-gate:0.1.0`。这是刻意的：强求同一个号码会让无关改动互相牵连。
   标签的用处是标记某一组摘要来自哪个源提交，自动生成的发布说明会列出全部四个。
4. 收到提示时批准 `ghcr-release` 环境。
5. 下载 `published-images` artifact，用 `docker buildx imagetools inspect` 核对摘要，再提交更新后的 `deploy/public/images.env`。

第 5 步是刻意的：工作流不能提交，必须由人确认摘要，之后它才成为部署所固定的
内容。运行摘要中列出了可直接粘贴的引用。

## 核对已发布镜像

```bash
# 解析器将要部署的摘要。
bash deploy/public/images.sh --field digest runtime

# 仓库为该标签报告的摘要。两者必须完全一致。
docker buildx imagetools inspect \
  ghcr.io/sagehou/dsh-workstation-runtime:0.2.1 --format '{{json .Manifest.Digest}}'

# 匿名拉取，也就是部署主机的行为。
docker pull ghcr.io/sagehou/dsh-workstation-runtime:0.2.1@sha256:...
```

## 平台

仅 `linux/amd64`。Runtime 镜像在容器启动时安装官方 DSH，而不是预置，因此镜像版本
与 DSH 版本相互独立：更新镜像不会改变运行的 DSH 版本。

## 与 Actions artifact 的关系

**Public Compose** 仍会上传镜像归档，那是某次运行实际执行内容的审计证据，保留
90 天；它不是分发渠道，部署文档也不再使用它。

## 已验证的内容

| 检查 | 证据 |
| --- | --- |
| 摘要引用能拉取并运行 | CI 把一次构建发布到本地回环 registry，用**真实解析器**解析出 `localhost:<端口>/name:version@sha256:...`，删除本地标签后重新拉取，并检查镜像 ID。此外 `release-compose` 作业在无凭据条件下拉取四个**真实 GHCR 摘要**，不执行构建，并通过与其他腿相同的整套检查。 |
| 升级跟随新摘要 | 以新版本号进行的第二次构建产生不同摘要，解析器随之跟随。 |
| 回滚恢复到完全相同的旧镜像 | 恢复首个摘要后拉取到的镜像 ID 与最初一致。 |
| 摘要缺失时失败，而非漂移到标签 | 解析器、其 18 项 shell 检查与初始化脚本全部失败。通过临时让解析器回退到标签验证：三项解析器检查与初始化脚本的 `--release` 检查均失败。 |
| 覆盖项无法把部署重定向到别处 | 除 `ghcr.io/sagehou` 或回环测试 registry 之外的地址一律拒绝。 |
| `compose.yml` 与解析器一致 | 双向断言：每个已发布镜像都通过其 override 键被消费；不存在无镜像对应的 override 键。 |

使用回环 registry 是刻意的：`WORKSTATION_IMAGE_REGISTRY` 只接受 GHCR 或回环地址，
因此该测试无法冒充发布。

### 首次发布（2026-11-23）

标签 `v0.2.0` 发布了四个镜像：

| 镜像 | 版本 | manifest list 摘要 |
| --- | --- | --- |
| `dsh-workstation-runtime` | 0.2.0 | `sha256:61dddb88c65ac8ee9cd891317b1b6f675384266c87f6ef428ba1b13e5cc33cff` |
| `dsh-workstation-auth` | 0.1.1 | `sha256:7a25eb333de2091ec1d1a622864cfa83b1aed5b22c42522a741e6fd946e1a2f6` |
| `dsh-workstation-provider` | 0.2.0 | `sha256:240c662037662cd3719eb50a572f972f5d8b1434df90e90448ce21658412393f` |
| `dsh-workstation-browser-gate` | 0.1.0 | `sha256:fc265c6f36806def3401c86925588671721f6cade13070c55aaf7284d3606c5f` |

已脱离工作流独立核对：每个标签的 `Docker-Content-Digest` 与记录值一致、每个
manifest list 含 `linux/amd64` 目标、且每个摘要都能用**匿名**拉取令牌解析——这才
说明包是公开的，而不只是存在。

首次尝试失败过，且失败都是真问题：

1. 构建作业对解析器输出的整行 `name=reference` 执行 `${reference%%:*}`，产生了
   标签 `ghcr.io/sagehou/runtime=dsh-workstation-runtime:0.2.1`。`record` 作业中
   另有两处同样缺陷。已修复，且 `images.test.sh` 现在断言工作流中每次调用解析器
   后都必须剥离前缀。
2. `public-compose.yml` 未监视 `.github/workflows/publish-images.yml`，导致本可
   捕获缺陷 (1) 的那道守卫在引入缺陷的改动上根本没运行。
3. `record` 作业在四次推送**全部成功之后**，因自身测试而失败：两个测试假定已提交
   的矩阵文件是未发布状态，填入真实摘要后即失败。拉取与可见性随后经手工核对。
   测试现在自行构造未发布状态，而不是依赖文件内容。

## 尚未验证

- 审批门槛需要管理员在 `ghcr-release` 环境中添加必需审批人。在此之前，打标签会
  无门槛发布——`v0.2.0` 就是这样发的。这一点无法由代码断言。
- 跨两个真实发布在部署主机上的升级与回滚尚未执行；目前只有一个发布版本。摘要
  机制本身已验证，但运维流程未在真实主机上演练。
- 仅发布 `linux/amd64`，不做多架构声明。
