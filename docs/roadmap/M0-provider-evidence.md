# M0 independent Browser Provider

English · [简体中文](M0-provider-evidence.zh-CN.md)

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [M0 decision](M0-evidence.md) · [Approved experiment design](M0-design.md)

**Gate C failed in this experiment and is now closed by [ADR-0005](../adr/0005-release-held-input-at-selkies.md).** The fixture enforced Agent leases and drained calls, but it failed to release a mouse button held before the handoff. The cause is an ordering property of the pinned Selkies, not a client gap; the release path is recorded below.

## Experiment topology

- The Provider is the sole client of the isolated CDP bridge. Chromium and the relay share a network namespace.
- DSH uses a separate bridge and discovers one fixed fixture action through official MCP. The experiment keeps the DSH package and browser image intact. [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md)

1. The trusted driver supplies distinct credentials through ACP. The control listener issues credentials and starts handover on a separate bridge. [public ACP session interface](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/acp/acp/README.md#standard-acp-v1-surface)
2. Each one-use credential binds to one stateful MCP session and its HTTP event stream. Before dispatch, the Provider checks the connection, generation, deadline, and that no operation is active.
3. On takeover or expiry, reject new calls, wait for the renderer, revoke the lease, and restore Selkies input. A persistent browser marker prevents unlocking the same Chromium process after uncertain completion.

## Reproduction on GitHub Actions

Run the exact experiment commit on `m0/issue-1` in the GitHub-hosted `ubuntu-24.04` job. [M0 Browser Provider workflow](../../.github/workflows/m0-provider.yml)

```sh
bash prototypes/m0/provider/run.sh
```

The job builds pinned fixtures, installs official DSH into a disposable volume, runs three Compose files and the assertion driver, then removes the containers and volumes. The script requires a GitHub-hosted runner.

npm and pnpm lifecycle scripts are disabled. The one approved `node-pty` build is separate. GitHub stores output in `m0-browser-provider`.

### Versions

- DSH `@deepseek-ai/dsh@0.2.2-rc.1`, with `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1` and its `@modelcontextprotocol/client@2.2.0`. The test driver starts `dsh --profile acp` and uses a deterministic loopback Messages SSE fixture. The npm DSH process itself performs MCP discovery, tool execution, and session persistence.
- The Provider uses `@modelcontextprotocol/sdk@1.31.0` stateful Streamable HTTP and `zod@4.4.3`. DSH and the Provider negotiated MCP `2025-11-25`. The lease uses the event stream of that stateful revision.
- Runtime and Provider Node `24.22.3`, runtime pnpm `11.28.5`, Chromium `156.0.8078.79` with CDP `1.3`, Selkies `2.2.1`, Playwright `1.61.1`, and Traefik `3.7.19`. [The pinned base image digests](M0-evidence.md#exact-upstream-versions) are unchanged.

Runner versions were Docker `28.0.4`, Compose `2.38.2`, and Node `22.23.4`.

### Earlier runs

| Run | Finding |
| --- | --- |
| [`6b1273e`](https://github.com/sagehou/dsh-workstation/actions/runs/44465917230/job/135363548859) | Images built, but `docker compose run` rejected `--no-build` before assertions. |
| [`2b38dee`](https://github.com/sagehou/dsh-workstation/actions/runs/44466292113/job/135364758280) | DSH installed and services started. An extra blank inventory line caused a mismatch despite the expected two CDP containers. The probe now ignores blank lines. |
| [`ffb3b37`](https://github.com/sagehou/dsh-workstation/actions/runs/44466616406/job/135365828906) | Network checks, MCP `2025-11-25`, the first real tool call, second Agent denial, and input gating with live video passed. DSH serialized the batch and returned `M0_OK,NO_LEASE` instead of `BUSY,M0_OK`. |

The scheduler serializes tools that do not declare concurrency safety. The final driver holds a real DSH operation open and sends a second standard MCP `tools/call` from the same authenticated DSH session. It requires `BUSY` before takeover, `HANDOVER` during drain, and no renderer effects from denied calls. [official scheduler](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L98-L113)

## Observed result

The job at `2fbed01` exercised each scenario and exited **1** at the held-pointer assertion. [job at `2fbed01`](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/job/135367748850) · [log artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/artifacts/14502827811)

| Case | Result | Observed behavior |
| --- | --- | --- |
| CDP and control | Pass | Only the Chromium namespace and Provider had CDP endpoints. Direct host, DSH, and viewer bridge access failed. DSH could not reach either control endpoint. MCP rejected an anonymous request. |
| Lease admission | Pass | The real DSH tool wrote a marker with a valid lease. No lease returned `NO_LEASE`, and a different session carrying the active generation got `NOT_OWNER`. Two concurrent grants yielded one grant and `NOT_HUMAN`. |
| Selkies input | Pass for new frames | Raw keyboard and button frames were blocked in Agent mode. Video continued on the same connection. |
| Concurrency and takeover | Pass | Overlap returned `BUSY`. A new call during drain returned `HANDOVER`. Neither reached the renderer. The held operation finished before the lease was revoked and human input returned on the same connection. |
| Expiry and generation | Pass | A `4500 ms` lease expired mid-operation. Admission closed while the renderer drained and video continued. The previous generation failed with no lease and with `STALE_GENERATION` after a fresh grant to the same DSH session. |
| DSH restart | Pass | `docker compose kill -s SIGKILL dsh` closed the MCP stream. Input stayed locked until the renderer settled. The persisted DSH session resumed and needed a fresh credential and lease. |
| Chromium restart | Pass | `docker compose kill -s SIGKILL chromium` interrupted the renderer and produced no completion marker. `DISCONNECTED` denied calls until explicit recovery on the restarted browser and a new generation. |
| Provider restart | Pass | After `docker compose kill -s SIGKILL provider`, the same Selkies connection kept video and blocked input while the operation finished. Restart returned `RESET_NEEDS_NEW_BROWSER` for the old process. Replacing Chromium allowed explicit recovery and a fresh lease. |
| Held mouse button | **Fail** | A mouse-down in HUMAN reached Chromium. Selkies switched to `MK_ACCESS,0` and dropped mouse-up. The Agent acted before release arrived. It arrived after takeover returned to HUMAN. |

### Failing assertion

```text
AssertionError [ERR_ASSERTION]: Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update
```

## Why the held button failed

The release cannot be issued after the revocation, and the experiment shows why from the server's side.

- Input authority is evaluated per frame against the live token table (`websockets_mode.py:6235`).
- `provision_tokens()` installs the new table **before** `reconcile_clients()` announces the change (`:8071-8072`, `:8356`).
- `reconcile_clients()` pushes `MK_ACCESS,0` but never calls `_release_held_input()`. That primitive exists and runs only on socket teardown and reconnect-grace expiry (`:6287`, `:6303`).

So the frame that would release a held button is dropped by the same rule that makes the gate work, and the client only learns of the change once it can no longer act on it. No upstream setting exposes release-on-authority-loss; a `reconcile_clients()` patch would still run after the table install.

## Decision

Before granting Agent control, stop prior human input, release held devices, and confirm the release. This experiment used neither an input proxy nor a UI toggle, and the gap it recorded is closed by a server-side WebSocket peer in front of the data socket. [ADR-0005](../adr/0005-release-held-input-at-selkies.md) · [token reconciliation](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L8297) · [release of held input](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L3103)

The gate releases with upstream's own primitives (`kr`, `m2,0,0,0,0,<seq>`), ordered before the Provider flips the table, and proves dispatch with a PING/PONG barrier on the same connection. See [M1](M1.md) for the observed results.

- The experiment used **one Provider**, a pinned Docker topology, and WebSocket Selkies with keyboard and mouse only. File transfers were disabled. A trusted ACP driver issued per-session credentials.
- Outside this run were Web Profile credential binding, official Playwright MCP Browser Use under a lease, network partitions, and host power loss.
- Gate D still requires native floating maximize and restore and the iframe lifecycle. The experiment did not change accepted ADRs or authorize M1.

Evidence recorded 2026-11-19 UTC.
