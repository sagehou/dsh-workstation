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
| 90 | [#5](https://github.com/sagehou/dsh-workstation/issues/5) | Native DSH Browser Sidebar | Deferred enhancement; standalone page remains supported. Does not block first release. |

## Release gates

### Gate A — deployable single-user workstation

- Traefik target patch passes the integration matrix.
- Docker subnet preflight/configuration passes on the deployment host.
- Single-admin bootstrap, password+TOTP, Passkey, session revocation, and recovery work.
- DSH and the standalone browser page work through the existing Traefik origin.
- DSH_HOME, workspace, browser profile, Auth DB, Provider state, and secrets have a tested backup/restore procedure.
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

[#10 — GHCR image publishing and immutable deployment references](https://github.com/sagehou/dsh-workstation/issues/10) adds `deploy/public/images.env` (a per-image manifest digest) and `deploy/public/images.sh` (a resolver that refuses a missing or malformed digest rather than falling back to a tag). The initializer gained `--release`, which writes the four digest-pinned GHCR references into `.env.public`; the default mode writes local build tags, and switching modes replaces the keys instead of appending. `publish-images.yml` runs only on a `v*` tag or a manual dispatch, holds `packages: write` in the publish job alone, targets an approval-gated environment, refuses to republish a version whose digest already differs, attaches SBOM and provenance to the digest, and then pulls every recorded digest anonymously. The Public Compose archive stays as audit evidence.

The initial publish has **not** happened yet, so the GHCR round-trip, anonymous pull from a clean host, and upgrade/rollback across two releases are unverified. The resolver, the cross-check against `compose.yml`, and the initializer's two modes are covered by tests.

The standalone browser page remains the first-release interface. Sidebar work (#5) is explicitly deferred.
