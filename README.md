# DSH Workstation

English · [简体中文](README.zh-CN.md)

A self-hosted workstation for the official DeepSeek Harness (DSH) npm package.

## Deploy

| I want to | Guide |
| --- | --- |
| Run on a domain with an existing Traefik | [Public Compose](deploy/public/README.md) |
| Try DSH Web and the browser over SSH | [Private preview](deploy/README.md) |

## Status

| Area | Current behavior |
| --- | --- |
| Runtime | Installs exact DSH versions into persistent storage. Switching and rollback are independent of the Runtime image. |
| Plugins and data | Uses the official DSH Profile, Bundle, and Plugin Manager. Container recreation preserves their state, pnpm store and lockfiles, credentials, sessions, and separate workspace. |
| Public access | One operator signs in over HTTPS using password and TOTP or Passkey. The Go gateway provides recovery codes, session controls, and Traefik ForwardAuth. |
| Browser | The operator and Agent share Chromium. Selkies runs at `/browser/`, and official MCP binds each live DSH session to its own tab. |
| Open work | Full exclusive handoff, including release of held input, and the native Sidebar. [#1](https://github.com/sagehou/dsh-workstation/issues/1) |
| Images | GitHub Actions builds the Compose images. Publishing project images to GHCR is a project goal. [Deployment evidence](docs/roadmap/public-compose.md) |

## Project documents

| For | Read |
| --- | --- |
| Product requirements and acceptance | [Specification](docs/SPEC.md) |
| Services, networks, and data | [Architecture](docs/ARCHITECTURE.md) |
| Architecture decisions | [Runtime versions](docs/adr/0001-runtime-version-decoupling.md) · [Shared Chromium](docs/adr/0002-shared-selkies-chromium.md) · [Auth gateway](docs/adr/0003-self-hosted-auth-gateway.md) |
| Reproducing tests | [M0 acceptance](docs/roadmap/M0.md) · [M0 results](docs/roadmap/M0-evidence.md) · [M1 preview](docs/roadmap/M1.md) · [Public Compose](docs/roadmap/public-compose.md) |
| Working on the repo | [Project instructions](AGENTS.md) |

The first release excludes changes to DSH core or its main UI, VNC/noVNC/Xvfb desktop stacks, a separate browser hostname or login, Windows Companion, and tenant isolation.

## License

The repository owner reserves all rights until a license is added.
