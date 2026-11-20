# M0 experiment design

English · [简体中文](M0-design.zh-CN.md)

Run the experiments on a disposable remote runner with fresh Compose volumes and without DeepSeek credentials. Use a separate branch for M0 and keep the fixtures out of production. [Scope in #1](https://github.com/sagehou/dsh-workstation/issues/1)

## Probes

| Gate | Design |
| --- | --- |
| A · Runtime | Pin Node and pnpm. Use a non-root UID and one DSH_HOME volume. Install exact versions in separate directories under a lock. |
| B · Browser | Pin the published LinuxServer image by digest. Attach Playwright to the browser's loopback CDP through a relay bound to one isolated interface. Preserve the Selkies path prefix at Traefik. |
| C · Exclusive control | Check the pinned Selkies secure-mode token table and the documented DSH tool guard. The viewer must keep video while losing input at dispatch. DSH must have no other path to CDP, including from its shell tools. |
| D · Extension APIs | Read the published Sidebar, client module, and Browser Use contracts. Use public APIs only. Registration, floating, and DOM retention do not establish support for a missing native operation. |

- Gate A requires an authenticated Web boot and Profile checks. Fail readiness intentionally once and confirm pointer rollback. Recreate without reinstalling and inspect the store, manifests, lockfile, links, and a Bundle's observed startup effect. Record lifecycle script results separately.
- Drive Selkies and CDP remotely for Gate B. Compare tabs and cookies, then check profile persistence, response headers, and transport.
- For Gate C, obtain an architecture decision before introducing a custom input-gating image or proxy.
- For Gate D, keep the probe outside DSH core and private dockkit imports.

## Independent Provider experiment

1. Join only the Provider client to the isolated CDP bridge. Use official ACP to give DSH a scoped, stateful Streamable HTTP MCP endpoint.
2. Bind each one-use credential to one connection. Revoke ownership when its MCP event stream closes. Run grant and takeover on a separate control network.
3. Check the live connection, generation, and deadline before dispatch. The tool writes a marker in an existing Chromium context.
4. Hold a real operation at a test barrier. Attempt a concurrent call and handover while sending Selkies input.
5. If disconnect leaves completion uncertain, retain the lock and require a fresh Chromium process before restoring input.

Use disposable volumes and secrets. The experiment adds no DSH API, Sidebar change, or product implementation.

## Evidence

Record commands, runner links, failures, and unfinished checks. Keep startup authentication URLs, tokens, and cookies out of logs. [M0 report](M0-evidence.md) · [Provider run](M0-provider-evidence.md)
