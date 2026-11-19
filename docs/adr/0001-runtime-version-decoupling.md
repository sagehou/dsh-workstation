# ADR-0001: Decouple DSH npm version from Runtime Image

Status: Accepted

## Context

DSH is distributed as an npm package. Baking one DSH version into every Runtime image couples application releases to base-image rebuilds and makes exact-version rollback unnecessarily difficult.

## Decision

- Runtime image provides compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and common native build tools.
- DSH is installed from the official npm registry into persistent DSH_HOME runtime directories.
- Multiple exact DSH versions coexist.
- A runtime manager selects an active version using an atomic pointer/manifest update.
- Install/verify happens before activation. Failed install or health check leaves the previous version active.
- DSH npm version, Runtime image version, Auth image version, Plugin version, and Chromium image version are independent.

## Consequences

- DSH upgrades do not rebuild the Runtime image.
- Runtime manager must validate Node compatibility and plugin compatibility.
- DSH_HOME must persist and be backed up before migrations.
- Code rollback does not guarantee data-schema rollback; restore is required when an upgrade migrates persistent state.
- Never mutate an active npm installation in place.
