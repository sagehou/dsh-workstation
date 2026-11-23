# DSH Workstation

English · [简体中文](README.zh-CN.md)

A self-hosted deployment, security, browser-control, and operations layer around the official DeepSeek Harness (DSH) application.

## Deploy

| I want to | Guide |
| --- | --- |
| Run on a domain with an existing Traefik | [Public Compose](deploy/public/README.md) |
| Try DSH Web and the browser over SSH | [Private preview](deploy/README.md) |

## Status

| Area | Current behavior |
| --- | --- |
| Product scope | First release is one local administrator, one DSH_HOME, one workspace, and one Chromium profile. Multiple Passkeys may belong to the administrator. |
| Runtime | Installs exact DSH versions into persistent storage. Switching and rollback are independent of the Runtime image; data migrations require matched backups. |
| Plugins and data | Uses the official DSH Profile, Bundle, and Plugin Manager. Container recreation preserves state, pnpm store and lockfiles, credentials, sessions, and separate workspace. |
| Public access | One operator signs in over HTTPS using password and TOTP or Passkey. Go Auth provides recovery codes, session controls, and Traefik ForwardAuth. |
| Browser | Operator and Agent share Chromium. Selkies runs at `/browser/`; the authenticated standalone browser/control page is the first-release UI. |
| Deferred | Native DSH Sidebar is post-launch and does not block deployment. Full exclusive handoff remains gated on release of held input. [#1](https://github.com/sagehou/dsh-workstation/issues/1) |
| Images | GitHub Actions builds Compose images. Publishing immutable Runtime/Auth/Provider images to GHCR is tracked. [Deployment evidence](docs/roadmap/public-compose.md) |

## Project documents

| For | Read |
| --- | --- |
| Product requirements and acceptance | [Specification](docs/SPEC.md) |
| Services, networks, and data | [Architecture](docs/ARCHITECTURE.md) |
| Architecture decisions | [Runtime versions](docs/adr/0001-runtime-version-decoupling.md) · [Shared Chromium](docs/adr/0002-shared-selkies-chromium.md) · [Auth gateway](docs/adr/0003-self-hosted-auth-gateway.md) · [Single-user release and deferred Sidebar](docs/adr/0004-single-user-release-and-deferred-sidebar.md) |
| Development and handoff | [Development roadmap](docs/roadmap/development-roadmap.md) |
| Reproducing tests | [M0 acceptance](docs/roadmap/M0.md) · [M0 results](docs/roadmap/M0-evidence.md) · [M1 preview](docs/roadmap/M1.md) · [Public Compose](docs/roadmap/public-compose.md) |
| Working on the repo | [Project instructions](AGENTS.md) |

The first release excludes multi-user tenancy, DSH core changes, a custom Agent runtime/editor, a public plugin marketplace, Kubernetes, Windows Companion, multiple simultaneous browsers, and a mandatory native Sidebar.

## License

The repository owner reserves all rights until a license is added.
