# 发布镜像

[English](release.md) · 简体中文

当前源码构建 `dsh-workstation-runtime` 和 `dsh-workstation-gateway`，用于 GHCR 公开发布。Provider 和输入门禁随 Gateway 镜像发布。Compose 固定 LinuxServer Chromium 的上游摘要，并在启动时挂载同一提交的 CDP 中继。

部署从不只引用标签。`deploy/public/images.env` 记录每个镜像的 manifest list
摘要，`deploy/public/images.sh` 把摘要解析成
`ghcr.io/sagehou/<名称>:<版本>@sha256:...`。摘要缺失即报错，因此该文件没有
任何路径可以产生浮动标签。

## 当前部署版本

`deploy/public/release-commit` 记录包含已发布摘要的部署提交，目前是 `81feffd`。该版本使用 Runtime 0.2.1、Auth 0.1.1、Provider 0.2.0 和 browser-gate 0.1.0。部署时配套使用该提交的 Compose 与初始化脚本。[发布镜像验证](https://github.com/sagehou/dsh-workstation/actions/runs/45816293100/job/139896902377)

三服务候选版构建 Runtime 0.2.2 和 Gateway 0.1.0，两者仍待发布并记录摘要。[镜像清单](../deploy/public/images.env) · [Gateway 迁移](../deploy/public/README.zh-CN.md#从-auth-迁移到-gateway) · [跟踪 Issue](https://github.com/sagehou/dsh-workstation/issues/36)

## 保障链条

| 性质 | 实现方式 |
| --- | --- |
| fork PR 无法发布 | 工作流没有 `pull_request` 触发器。只有 `push: tags` 与 `workflow_dispatch` 会运行，二者在 fork 中都无法触达。 |
| 不可信输入接触不到凭据 | `plan` 作业不持有任何仓库凭据，只读取受版本控制的镜像清单。`publish` 从 `plan` 接收矩阵，并用 `deploy/public/images.sh` 校验镜像名。 |
| 同一标签不能用不同内容重发 | 若 `images.env` 已记录该版本的摘要，发布不同摘要会失败，而不会覆盖部署可能正在使用的引用。 |
| 无法从 fork 触发发布 | 发布需要 `v*` 标签或由有写权限的人手动触发。没有审批提示，也不声称有：本仓库只有一名操作者，而该操作者也是唯一能触发发布的人，第二个审批人只会增加一次点击，而不是一层控制。触发器就是门槛。 |
| 构建来源随镜像保留 | `provenance: mode=max` 与 `sbom: true` 把证明附着到摘要上，而不是某次 Actions 运行。 |
| 发布用的标签就是部署读取的标签 | 工作流与初始化脚本的镜像名都来自同一个解析器。 |
| 无法部署 `latest` | 解析器只接受 `X.Y.Z`，且没有任何工作流产生 `latest` 标签。 |
| 镜像确实公开 | `record` 作业匿名拉取本次发布的每个摘要。部署 CI 检查整套发布镜像。 |

## 一次性配置（仓库管理员）

1. 首次发布后，在包设置中确认每个包的可见性为 **Public**。未授予 `packages: write`
   的作业所创建的包，即使在公开仓库里也可能变成私有；`record` 会在这种情况下失败，
   但可见性本身是仓库设置，不是代码。
2. 保护 `v*` 标签，使只有维护者能创建。这才是真正起作用的控制，因为标签就是发布触发器。

这里**刻意不设审批环境**。没有必需审批人的 `ghcr-release` 环境拦不住任何东西，把它
描述成审批门槛就是夸大实际执行力。若将来变成多人操作的仓库，请添加必需审批人，并
**重新验证**该门槛确实能拦住打标签，再声称它成立。

不需要任何仓库 secret：工作流使用自动的 `GITHUB_TOKEN`，仅在 `publish` 作业中
授予 `packages: write`。

## 发布步骤

1. 在 `deploy/public/images.env` 中给有变更的镜像提升版本号并清空摘要，发布后填入摘要。Runtime 与 Gateway 各自版本化。
2. 合并该变更。
3. 在 `main` 上运行 **Publish images**（`image: all`），或给发布源码提交创建新的 `v<版本>` 标签。`all` 只发布摘要为空的版本。

   各镜像独立版本化。标签标识构建用的源码提交，工作流记录带摘要的镜像引用。
4. 下载 `published-images` artifact，用 `docker buildx imagetools inspect` 核对摘要，再提交更新后的 `deploy/public/images.env`。

5. 把 `deploy/public/release-commit` 更新为已包含这些摘要的部署提交的完整 SHA，再核对 `release-compose`。该作业从同一提交读取 Compose 配置和探针，匿名拉取其中记录的镜像。

旧的 `dsh-workstation-auth` 镜像仍供旧部署使用。[Gateway 迁移](../deploy/public/README.zh-CN.md#从-auth-迁移到-gateway)

## 核对已发布镜像

在所核对版本的部署提交中执行以下命令。

```bash
resolved="$(bash deploy/public/images.sh runtime)" &&
  image="${resolved#*=}"

# 仓库为该标签报告的摘要应与记录值一致。
printf '%s\n' "${image#*@}"
docker buildx imagetools inspect "${image%@*}" --format '{{json .Manifest.Digest}}'

# 匿名拉取，也就是部署主机的行为。
docker pull "$image"
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
| 摘要引用能拉取并运行 | CI 在本地回环 registry 验证解析器。`release-compose` 产物记录本次拉取的发布摘要、对应部署提交和端到端检查结果。 |
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
| `dsh-workstation-runtime` | 0.2.0 | `sha256:61dddb88c65ac8ee9cd891317b1b6f675384266c87f6ef428ba1b13e5cc33cff`（已损坏，由 0.2.1 取代） |
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

随后发现 `runtime:0.2.0` 不可用，而发现它的正是同一分支新增的发布腿：

```
runtime-1 | dsh-runtime: cannot locate compat.mjs and state.mjs
```

已发布的层中 `usr/local/lib/dsh-runtime/` 的权限是 **0644**。`COPY --chmod`
同样作用于它创建的目录，而不只是被命名的文件，于是模块目录失去了执行位；
容器以 `node` 运行、无法进入该目录，辅助模块查找失败。本地构建的镜像恰好不受
影响，因此所有栈测试通过，而发布产物是坏的。仅把每个文件写成完整路径并不够——
父目录仍由 COPY 创建。`install -d -m 0755` 在任何 COPY 之前建好目录才真正解决；
已发布的层现在显示 `0000755 DIR`。

`publish` 现在在推送**之前**对镜像做冒烟测试，这类缺陷因此无法到达标签：检查
失败的版本不会被发布，已发布的版本会被拒绝而不是被覆盖。所以 runtime 为
`0.2.1`，而 `0.2.0` 仍是公开但损坏的。这是刻意的：撤回别人可能已固定的摘要，
比留下一个明确被取代的版本更糟。

| `dsh-workstation-runtime` | 0.2.1 | `sha256:8fabc8a912436e85f17e83166ef2584f19110cd7428a1ce3ca8434a64926fc6a` |

## 尚未验证

- 跨两个真实发布在部署主机上的升级与回滚尚未执行；目前只有一个发布版本。摘要
  机制本身已验证，但运维流程未在真实主机上演练。
- 仅发布 `linux/amd64`，不做多架构声明。
