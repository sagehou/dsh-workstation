# Development roadmap and coding-agent handoff

English · [简体中文](development-roadmap.zh-CN.md)

**Baseline approved: 2026-11-23.** This roadmap implements [ADR-0004](../adr/0004-single-user-release-and-deferred-sidebar.md). Issue title prefixes are execution order; GitHub Issue numbers remain permanent identifiers.

## Product guardrails

- Official DSH remains the Agent runtime and primary chat/session/terminal/plugin experience.
- First release is one local administrator, one DSH_HOME, one workspace, and one Chromium profile. Multiple Passkeys for that administrator are supported.
- The authenticated standalone browser/control page is the first-release UI. Native Sidebar is deferred and cannot block deployment.
- No DSH core fork, custom Agent runtime, replacement plugin manager, public plugin marketplace, multi-user shared mode, or Kubernetes.
- Initial deployment support is Linux amd64.
- `BROWSER_TOOL_ORIGINS` is an application-layer origin allowlist, not network egress isolation. Keep Agent browsing disabled/restricted until the separate egress policy is implemented for untrusted destinations.

## Ordered work

| Order | Issue | Work | Dependency / exit condition |
| --- | --- | --- | --- |
| 00 | [#7](https://github.com/sagehou/dsh-workstation/issues/7) | Issue-first development and agent progress discipline | Required for all work; AGENTS rules already committed, verify subsequent tasks follow them. |
| 01 | [#3](https://github.com/sagehou/dsh-workstation/issues/3) | Traefik 3.7.14 and 3.7.19 compatibility matrix | Passed both legs; the edge version cannot be resolved unless it is pinned. |
| 02 | [#8](https://github.com/sagehou/dsh-workstation/issues/8) | Transactional DSH/Profile upgrade and data recovery | Before relying on in-place upgrades or migrations on user data. |
| 03 | [#9](https://github.com/sagehou/dsh-workstation/issues/9) | Configurable Docker subnets and overlap preflight | Before target-host deployment. Derive fixed IPs, health checks, and certificate SANs from one configuration. |
| 04 | [#4](https://github.com/sagehou/dsh-workstation/issues/4) | Browser exclusive input and safe handoff | Before enabling Agent control of the shared browser. |
| 05 | [#10](https://github.com/sagehou/dsh-workstation/issues/10) | GHCR image publishing and immutable deployment references | Before declaring repeatable release distribution. |
| 06 | [#6](https://github.com/sagehou/dsh-workstation/issues/6) | Target-host deployment, HTTPS, backup/restore and recovery drill | Requires #3, #8, #9, and #10. Agent browser control stays disabled until #4; untrusted-site browsing stays disabled until #11. |
| 07 | [#11](https://github.com/sagehou/dsh-workstation/issues/11) | Browser egress policy and SSRF boundary | Required before enabling broad Agent browsing of untrusted sites. |
| 08 | [#23](https://github.com/sagehou/dsh-workstation/issues/23) | CI coverage on `main` | Before trusting that the merged tree is the tested tree; #6 deploys from main. |
| 09 | [#26](https://github.com/sagehou/dsh-workstation/issues/26) | Core deployment without the shared browser | Two-service Compose configuration and HTTPS login verified. |
| 11–13 | [#29](https://github.com/sagehou/dsh-workstation/issues/29) · [#30](https://github.com/sagehou/dsh-workstation/issues/30) · [#31](https://github.com/sagehou/dsh-workstation/issues/31) | Agent-first lease, browser egress hardening and recording | Automatic acquisition passed source Compose. Egress and recording acceptance remain open. |
| 14–16 | [#32](https://github.com/sagehou/dsh-workstation/issues/32) · [#33](https://github.com/sagehou/dsh-workstation/issues/33) · [#35](https://github.com/sagehou/dsh-workstation/issues/35) | Operations console, Gateway rename and UI | Console and authentication verified in source CI. Gateway image publication and migration on the deployment host remain open. |
| 17 | [#36](https://github.com/sagehou/dsh-workstation/issues/36) | Three-service full deployment | Runtime, Gateway and Browser. Verify CDP isolation, browser recreation and existing login and lease flows. |
| 18 | [#37](https://github.com/sagehou/dsh-workstation/issues/37) | Shared workstation network | Direct-access boundaries, certificate preservation and browser handoff with Agent MCP enabled passed. [Compose evidence](public-compose.md#shared-network-verification) |
| 90 | [#5](https://github.com/sagehou/dsh-workstation/issues/5) | Native DSH Browser Sidebar | Deferred enhancement; standalone page remains supported. Does not block first release. |

## Release gates

### Gate A — deployable single-user workstation

- Traefik target patch passes the integration matrix.
- Docker subnet preflight/configuration passes on the deployment host.
- Single-admin bootstrap, password+TOTP, Passkey, session revocation, and recovery work.
- DSH and the standalone browser page work through the existing Traefik origin.
- DSH_HOME, workspace, browser profile, Gateway SQLite, Provider state, and secrets have a tested backup/restore procedure.
- No claim of multi-user isolation or ARM64 support.

### Gate B — safe Agent browser control

- All browser tools pass the same server-side lease/session/generation gate.
- Selkies blocks human input while Agent owns the lease.
- Held input is released and confirmed before ownership changes.
- Expiry, concurrency, disconnect, Provider restart, and Chromium restart fail closed.
- Agent browser access is not enabled in production before this gate passes.

### Gate C — untrusted browsing

- Enforce browser egress controls outside the model prompt.
- Resolve and validate destinations, block prohibited IP ranges, and revalidate redirects.
- Verify DNS rebinding, IPv4/IPv6, loopback, link-local, private and cloud metadata destinations.
- Origin allowlists alone do not satisfy this gate.

### Gate D — native Sidebar (post-launch)

- Public DSH APIs only; no core fork/private DOM.
- Verify dock/float/resize/maximize/restore/hide/reconnect and iframe lifecycle.
- Keep standalone browser/control page as a fallback.

## Coding-agent handoff contract

For every assigned Issue, the agent must:

1. Read this roadmap, ADR-0004, SPEC, ARCHITECTURE, and the linked Issue before editing.
2. Confirm the Issue scope, dependencies, and acceptance checklist. If a required Issue is missing, create it before implementation.
3. Keep changes within the assigned Issue. Do not opportunistically refactor unrelated services.
4. Update Issue checkboxes and add progress/blocker comments at meaningful milestones.
5. Add `Refs #N` or `Closes #N` to every PR. Do not close an Issue solely because a PR merged.
6. Run the exact tests and compatibility versions required by the Issue. Record commands, versions, CI run/job links, and observed outcomes.
7. Report completed and failed acceptance criteria, commit/PR, remaining risks, and next blocking decision.
8. Never claim deployment, recovery, architecture compatibility, or security guarantees without reproducible evidence.

## Current handoff

[#4 — browser exclusive input and safe handoff](https://github.com/sagehou/dsh-workstation/issues/4) shipped under [ADR-0005](../adr/0005-release-held-input-at-selkies.md). The pinned Selkies evaluates input authority per frame against the live token table and installs a new table *before* it announces the change, so a release sent after a revocation is dropped — exactly the M0 failure, stated from the server's side. Rather than fork Selkies, a small `browser-gate` sits at the input boundary and releases held input with upstream's own `reset_keyboard()` and `release_mouse_buttons()` primitives, ordered before the Provider flips the table, with a PING/PONG barrier proving dispatch.

The held-input release is **measured on the real stack**, not inferred: a button pressed and held on the operator's own Selkies socket, handed over, reads back from the Agent's tab as one press and one release; a client that vanishes mid-press leaves no press behind; and removing the gate call makes the same probe report a press with no release. Held keys and modifiers, lease expiry mid-press, Chromium restart mid-press, and Provider abnormal exit are covered by tests against a fake upstream that enforces the traced ordering, and have **not** been measured on a real host. Until they are, treat the exclusivity claim as proven for pointer buttons and for disconnection, and not yet proven for the rest.

[#10 — GHCR image publishing and immutable deployment references](https://github.com/sagehou/dsh-workstation/issues/10) adds `deploy/public/images.env` (a per-image manifest digest) and `deploy/public/images.sh` (a resolver that refuses a missing or malformed digest rather than falling back to a tag). The initializer gained `--release`, which writes the four digest-pinned GHCR references into `.env.public`; the default mode writes local build tags, and switching modes replaces the keys instead of appending. `publish-images.yml` runs only on a `v*` tag or a manual dispatch, holds `packages: write` in the publish job alone, is reachable only from a tag or a manual dispatch so a fork PR cannot publish, refuses to republish a version whose digest already differs, attaches SBOM and provenance to the digest, and then pulls every recorded digest anonymously. The Public Compose archive stays as audit evidence.

The digest mechanism is measured on a real daemon against a loopback registry: a pinned reference pulls, an upgrade follows a new digest, rollback restores exactly the earlier image, and a cleared digest fails instead of drifting to a tag. `WORKSTATION_IMAGE_REGISTRY` accepts only GHCR or a loopback address, so that test cannot masquerade as a publish.

The first publish **has** happened: tag `v0.2.0` pushed all four images, and each recorded manifest digest was confirmed against the registry independently of the workflow, resolves with an anonymous pull token, and carries a `linux/amd64` target. The `release-compose` CI job now pulls those digests with no credential, builds nothing, and passes the same stack checks, so "the published artifacts run" is measured rather than assumed.

The `release-compose` leg found, on its first run, that `runtime:0.2.0` could not start: `COPY --chmod` had set its module directory to 0644, so the container running as `node` could not enter it. Release now smoke-tests an image before pushing it, and runtime is `0.2.1`; `0.2.0` stays published and visibly superseded. A locally built image had passed every stack test, so nothing short of running the published artifact would have caught this.

There is no approval gate, and none is claimed: one operator is also the only person able to trigger a publish, so the trigger set is the control. What remains unverified: an upgrade/rollback drill across two releases on a real deployment host, and any non-`amd64` artifact.

[#23 — CI coverage on `main`](https://github.com/sagehou/dsh-workstation/issues/23) closes a gap this handoff previously left out rather than fixed: until now no workflow triggered on `main`, so `?branch=main` returned **zero** runs. Every PR passed on its own branch, which is why this was not a shipped-broken-code problem, but a green pull request does not prove the merged tree is green — a squash, a conflict resolution, or two individually passing PRs can still interact badly, and nothing would have noticed on the commit that is actually deployed. `Public Compose` and `M1 private preview` now also run on `main`; `Publish images` stays restricted to a `v*` tag or a manual dispatch, so a main push cannot publish. The M0 workflows lose their `push` trigger, because the `m0/issue-1` branch they watched no longer exists — they remain available by manual dispatch so the M0 evidence stays reproducible without putting prototype jobs on every main run.

The published Auth stack supports the two-container core deployment. Target-host Traefik compatibility, subnet preflight, HTTPS and backup/restore still need acceptance. [Deployment issue #6](https://github.com/sagehou/dsh-workstation/issues/6)

Gateway and the redesigned console are in PR #34. Its candidate browser uses automatic lease acquisition and permits all HTTPS tool origins when the allowlist is empty. The production checks above apply. The standalone browser page remains the first-release interface. [PR #34](https://github.com/sagehou/dsh-workstation/pull/34) · [Compose evidence](public-compose.md#gateway-candidate-verification) · [Release status](../release.md#current-deployment) · [ADR-0006](../adr/0006-agent-first-browser-and-default-open-origins.md)
