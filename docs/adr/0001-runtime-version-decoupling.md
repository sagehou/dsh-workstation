# ADR-0001 — Decouple DSH npm versions from the Runtime image

English · [简体中文](0001-runtime-version-decoupling.zh-CN.md)

**Accepted**

## Context

Baking DSH into each image couples npm releases to image rebuilds and makes it harder to roll back to an exact version.

## Decision

The Runtime image supplies compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and common native build tools. Multiple exact DSH versions from the official npm registry coexist in persistent DSH_HOME directories.

1. Install a candidate in its own directory and validate Node and plugin compatibility.
2. Update the active pointer or manifest atomically after verification.
3. Check readiness and keep or restore the previous selection if installation or the health check fails.

Version DSH npm, the Runtime image, Auth, the plugin, and Chromium independently.

## Consequences

- Upgrade DSH without rebuilding the Runtime image. Keep the active npm installation intact during upgrades.
- Back up DSH_HOME before migrations. If an upgrade migrates state, restoring it requires the corresponding data backup.

[M0 Runtime evidence](../roadmap/M0-evidence.md#a--runtime-and-profile)
