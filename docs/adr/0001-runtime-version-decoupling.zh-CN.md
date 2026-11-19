# ADR-0001：DSH npm 版本与 Runtime 镜像解耦

[English](0001-runtime-version-decoupling.md) · 简体中文

状态：已接受。

## 背景

DSH 以 npm 包分发。把单个 DSH 版本打进每个 Runtime 镜像，会让应用发布依赖基础镜像重建，增加回滚到指定版本的难度。

## 决策

- Runtime 镜像提供兼容的 Node.js、固定版本的 pnpm、Git/SSH、CA 证书和常用原生构建工具。
- 从官方 npm registry 把 DSH 安装到持久化的 DSH_HOME Runtime 目录。
- 允许多个确切的 DSH 版本共存。
- Runtime 管理器原子更新指针或清单，指定活动版本。
- 激活之前完成安装和验证。安装或健康检查失败时保留先前的活动版本。
- DSH npm 版本、Runtime 镜像版本、认证镜像版本、插件版本和 Chromium 镜像版本各自独立。

## 后果

- DSH 升级无需重建 Runtime 镜像。
- Runtime 管理器必须检查 Node 兼容性和插件兼容性。
- 持久化 DSH_HOME，迁移前备份。
- 回滚代码无法保证回退数据结构。若升级迁移了持久化状态，需要恢复备份。
- 不就地修改处于活动状态的 npm 安装。
