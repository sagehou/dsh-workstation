# DSH Workstation

A Docker Compose-based, self-hosted web workstation built around the official DeepSeek Harness (DSH) runtime.

## Project status

**Planning / M0 validation.** This repository is the implementation handoff for Codex. No production-ready image, authentication gateway, browser-control integration, or UI plugin is claimed to exist yet.

## Goals

- Run the official DSH npm package without forking DSH core.
- Keep the DSH runtime version independent from the base Docker image; support installing, selecting, upgrading, and rolling back pinned npm versions.
- Preserve the official DSH Profile, Bundle, Plugin Manager, pnpm lockfiles, package store, credentials, sessions, and workspace data across container recreation.
- Provide a shared LinuxServer Chromium instance through Selkies for human interaction and CDP/Playwright automation.
- Embed Selkies at `/browser/` on the same origin as DSH.
- Enforce exclusive human/agent browser control with server-side leases, not UI-only state.
- Provide a small self-hosted Go authentication gateway with password + TOTP, Passkeys/WebAuthn, recovery codes, configurable sessions, and Traefik ForwardAuth.
- Deploy through Docker Compose and publish project-owned images to GHCR.

## Non-goals for the first release

- Forking or patching DSH core.
- Replacing the DSH Agent runtime or main UI.
- VNC/noVNC/Xvfb desktop stacks.
- A separate browser hostname or separate browser login.
- Windows Companion.
- Multi-tenant DSH isolation. Supporting several auth accounts does not imply isolated DSH workspaces or browser profiles.

## Start here

1. Read [AGENTS.md](AGENTS.md) for Codex instructions.
2. Read [SPEC.md](docs/SPEC.md) for product requirements and acceptance criteria.
3. Read [ARCHITECTURE.md](docs/ARCHITECTURE.md) for component boundaries and deployment topology.
4. Read the [ADRs](docs/adr/) for decisions and unresolved validation gates.
5. Start with [M0](docs/roadmap/M0.md). Do not implement later phases until the M0 gates pass.

## Important engineering rule

Treat upstream DSH, LinuxServer Chromium/Selkies, Traefik, and security-library behavior as versioned external contracts. Verify against the exact pinned versions and upstream source before relying on an API, environment variable, path, or CLI option. Do not copy unverified assumptions from planning notes into production code.

## License

No license has been selected yet. Until one is added, all rights are reserved by the repository owner.
