# ADR-0004 — Single-user first release and deferred native Sidebar

**Accepted — 2026-11-23**

## Context

The project has a working single-user Compose topology, self-hosted authentication, a shared Chromium browser, and an official DSH integration. The original product specification left room for 2–5 Auth accounts while explicitly not providing tenant isolation. It also treated native Sidebar behavior as part of the target workstation UI, even though upstream floating/maximize/iframe lifecycle behavior remains incomplete.

## Decisions

1. **Exactly one local administrator in the first release.** Bootstrap creates one account and closes. No user creation, invitation, role management, or second account. Multiple Passkeys are allowed for the same administrator.
2. **No shared multi-user mode.** A second account must not be added while DSH_HOME, workspace, Chromium profile, Provider state, and secrets remain shared. Multi-user requires a future per-tenant isolation architecture.
3. **The standalone authenticated browser/control page is the first-release browser UI.** It must remain supported and fully usable without the DSH Sidebar.
4. **Native Sidebar is deferred, not cancelled.** Implement later using public DSH APIs only. No DSH core fork, private DOM hooks, or release-blocking dependency on upstream floating/maximize behavior.
5. **Keep official DSH as the product core.** Do not build a replacement Agent runtime, chat/session UI, editor, package manager, or public plugin marketplace.
6. **Release gates are evidence-based.** CI on a newer Traefik version does not prove compatibility with the target deployment version. A merged PR does not close acceptance criteria without test evidence.

## Consequences

- Auth remains a small single-administrator service; remove ambiguous multi-account assumptions from product docs and UI plans.
- The standalone browser/control page is a required product surface and fallback.
- Sidebar work may proceed after the first stable deployment without blocking it.
- The first release is Linux amd64 and single-user. Multi-user, tenant orchestration, and multiple simultaneous browsers remain out of scope.
- Security, browser handoff, backup/restore, and target-host verification remain release gates.

## Related decisions and work

- [Product specification](../SPEC.md)
- [Architecture](../ARCHITECTURE.md)
- [Development roadmap](../roadmap/development-roadmap.md)
- [Issue #1 — M0 tracking](https://github.com/sagehou/dsh-workstation/issues/1)
