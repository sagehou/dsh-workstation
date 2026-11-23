# AGENTS.md — DSH Workstation

English · [简体中文](AGENTS.zh-CN.md)

Build a Docker Compose workstation around the **official DeepSeek Harness (DSH) npm package**. This repository owns its Runtime image, version manager, Go Auth, Workstation plugin, deployment configuration, and tests.

## Non-negotiable constraints

### DSH and Runtime

- **Do not fork or patch DSH core.** Use documented Profile, Bundle, Plugin Manager, Cordis patch, and client plugin APIs. If the supported extension points cannot meet a requirement, document the gap and stop for an architecture decision.
- **Install exact DSH npm versions at runtime.** The image supplies compatible Node.js, pinned pnpm, Git/SSH, CA certificates, and a plugin-capable toolchain. Keep DSH installations in persistent storage. The version manager installs multiple versions and selects or rolls back the active version.
- Keep the official Plugin Manager. Preserve Profile manifests, lockfiles, pnpm store, installed dependencies, Bundle configuration, credentials, sessions, and the rest of DSH_HOME.
- Verify upstream APIs, paths, flags, environment variables, plugin IDs, and compatibility against the exact release and source. Record the evidence.

### Browser

- Human and Agent share **one Chromium process and persistent profile**. The operator uses LinuxServer Chromium/Selkies, and the Agent attaches to that same instance over CDP.
- Serve Selkies at same-origin `/browser/`, with the same login as DSH. Protect both routes with Traefik ForwardAuth. Exclude VNC and noVNC.
- **Exclusive control requires server-side tool checks and gating at the Selkies input path.** Report any unproven input gate. A front-end toggle cannot satisfy this requirement.
- Keep CDP off host and public interfaces.

### Auth and deployment

- Go Auth is a separate SQLite service. Support password followed by TOTP on a separate screen, Passkeys/WebAuthn, recovery codes, configurable idle and absolute session lifetimes, revocation, audit, and Traefik ForwardAuth.
- Require TOTP enrollment for accounts and TOTP for password login. Passkey may serve as a separate phishing-resistant login. Do not require three factors together.
- Deploy for one operator. Multiple accounts do not establish tenant isolation. Each tenant would need separate DSH state, workspace, and browser profile.
- Deploy with Docker Compose and version services independently. Redis, PostgreSQL, Browserless, and Authentik require a demonstrated need.
- Keep secrets out of images, source, logs, and committed Compose files. Keep the Docker socket out of DSH and Auth.

## Development workflow

1. Begin with [M0](docs/roadmap/M0.md). Pass the validation gates before full implementation.
2. Inspect upstream contracts. Record the design, implement the smallest vertical slice, add and run automated tests, and document the results and limits.
3. Pin exact versions and image digests. Use floating tags only in marked experiments. Keep the Runtime image and DSH npm version independent.
4. Install upgrades into independent directories. Validate, switch atomically, check readiness, and roll back on failure. Keep the active installation intact.
5. Back up DSH_HOME before migrations or Profile dependency changes. Restore matching state if a data migration must be rolled back.
6. Obtain explicit review and approval for pnpm install scripts or native build scripts. Never approve all dependency build scripts by default.
7. Test container recreation and persistent state. Audit sensitive operations and use step-up authentication for credential and MFA changes.

## Code quality

| Area | Requirements |
| --- | --- |
| Modules | Small modules with explicit interfaces. |
| Go | Context-aware handlers, structured logs, migrations, race tests for session and lease logic, constant-time comparisons where applicable, secure random tokens, and parameterized SQL. |
| TypeScript | Use the pinned release's client plugin API. Document and justify any private or internal import. |
| Docker | Run as non-root where compatible. Use least privilege, no privileged mode or Docker socket mount, health checks, and read-only root filesystems where practical. |
| Logs | Exclude passwords, TOTP codes and seeds, WebAuthn assertions, recovery codes, session tokens, and encryption keys. |
| Documentation | Mark unverified PoC settings and keep production claims tied to evidence. |

## Required completion report

- Changes and exact versions tested.
- Commands, observed results, and acceptance items passed or failed.
- Remaining risks and the next blocking decision.
- Commit, PR, and Issue links when available.


## Issue and progress management (required)

- Before implementation, inspect open Issues and the approved specification/roadmap. Every independently deliverable phase or blocking item must have a GitHub Issue before coding starts; do not leave phase planning only in chat or a local TODO list.
- Keep one parent tracking Issue for the current milestone. Create child Issues with scope, dependencies, concrete checkboxes, acceptance criteria, and links to the parent/spec. Avoid duplicate Issues by searching first.
- Every PR must reference its Issue with `Closes #N` or `Refs #N`. A PR merge alone does not prove the Issue acceptance criteria passed; close an Issue only after checking the evidence.
- At the start of each task, comment on the Issue with the intended scope. During work, update checkboxes and post material progress/blockers. On completion, report exact versions, commands, CI run links, observed results, remaining risks, and commit/PR links.
- Keep status truthful: planned, in progress, blocked, verified, or done. CI on a different dependency version is not target-environment verification. Record compatibility matrices and deployment-host evidence separately.
- Before handing work to a coding agent, provide the Issue number, dependencies, acceptance criteria, test commands, and required progress-report cadence. The agent must not silently skip Issue creation or progress updates.
