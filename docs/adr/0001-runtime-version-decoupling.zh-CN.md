# ADR-0001 — DSH npm 版本与 Runtime 镜像解耦

[English](0001-runtime-version-decoupling.md) · 简体中文

**已接受**

## 背景

把 DSH 打进每个镜像会让 npm 发布依赖镜像重建，也会增加回滚到指定版本的难度。

## 决策

Runtime 镜像包含兼容的 Node.js、固定版本 pnpm、Git/SSH、CA 证书和常用原生构建工具。来自官方 npm registry 的多个确切 DSH 版本共存在 DSH_HOME 的持久化目录中。

1. 在独立目录安装候选版本，检查 Node 和插件兼容性。
2. 验证后原子更新活动版本的指针或清单。
3. 检查就绪状态。安装或健康检查失败时保留或恢复上一版本。

DSH npm、Runtime 镜像、Auth、插件和 Chromium 各自版本化。

## 后果

- 升级 DSH 无需重建 Runtime 镜像，活动 npm 安装保持完整。
- 迁移前备份 DSH_HOME。升级如果迁移了状态，须用对应的数据备份恢复。

[M0 Runtime 证据](../roadmap/M0-evidence.zh-CN.md#a--runtime-和-profile)
