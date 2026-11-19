# M0 independent Browser Provider

[Issue #1](https://github.com/sagehou/dsh-workstation/issues/1) · [M0 decision](M0-evidence.md) · [Approved experiment design](M0-design.md)

This is a disposable follow-up to Gate C and to the Browser Use extension check in Gate D. The provider is the only client joined to the isolated CDP bridge; the relay and Chromium share a network namespace. DSH is on the separate MCP bridge. Its only browser tool is a fixed fixture action discovered through DSH's [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md). No DSH package or upstream browser image was modified.

The trusted Actions driver configures distinct connection credentials on the [public ACP session interface](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/acp/acp/README.md#standard-acp-v1-surface). Only the control endpoint can issue credentials or start a handover; it listens on a separate internal bridge. The MCP listener binds a one-use credential to one stateful MCP session and its HTTP event stream. It validates that connection, the active generation, the deadline, and the absence of another action before dispatch. A takeover or expiry stops admission, waits for the actual renderer operation, revokes the lease, and then enables Selkies input. A crash can leave a renderer operation running, so a persistent browser identity fence prevents input from resuming on the same Chromium process when completion is uncertain.

## Reproduction on GitHub Actions

Use the [M0 Browser Provider workflow](../../.github/workflows/m0-provider.yml) with the exact experiment commit on `m0/issue-1`. The hosted `ubuntu-24.04` job executes:

```sh
bash prototypes/m0/provider/run.sh
```

The script rejects a non-GitHub-hosted environment. It builds the pinned fixture images, installs the exact official DSH npm package into a disposable volume, runs the three Compose files and the assertion driver, and removes the containers and volumes. npm and pnpm lifecycle scripts are disabled. The once-approved `node-pty` native build is outside this workflow. GitHub saves the command output as `m0-browser-provider`.

- DSH `@deepseek-ai/dsh@0.2.2-rc.1`, with `@deepseek-ai/dsh-mcp-client@0.2.2-rc.1` and its `@modelcontextprotocol/client@2.2.0`. The test driver starts `dsh --profile acp` and uses a deterministic loopback Messages SSE fixture. The npm DSH process itself performs MCP discovery, tool execution, and session persistence.
- The Provider uses `@modelcontextprotocol/sdk@1.31.0` stateful Streamable HTTP and `zod@4.4.3`. DSH and the Provider negotiated MCP `2025-11-25`; the lease uses the event stream of that stateful revision.
- Runtime and Provider Node `24.22.3`, runtime pnpm `11.28.5`, Chromium `156.0.8078.79` with CDP `1.3`, Selkies `2.2.1`, Playwright `1.61.1`, and Traefik `3.7.19`. [The pinned base image digests](M0-evidence.md#exact-upstream-versions) are unchanged.

The hosted runner reports Docker `28.0.4`, Compose `2.38.2`, and runner Node `22.23.4`. The run at [`6b1273e`](https://github.com/sagehou/dsh-workstation/actions/runs/44465917230/job/135363548859) built the images but stopped before executing assertions: `docker compose run` did not support `--no-build`. The run at [`2b38dee`](https://github.com/sagehou/dsh-workstation/actions/runs/44466292113/job/135364758280) installed DSH and started the topology. The CDP network inventory showed exactly the two expected containers, with an extra blank line that stopped the comparison. The fixture now ignores blank inventory lines.

The run at [`ffb3b37`](https://github.com/sagehou/dsh-workstation/actions/runs/44466616406/job/135365828906) passed the network controls, negotiated MCP `2025-11-25`, exercised a real DSH tool call, denied a second Agent, and blocked raw Selkies keyboard and mouse input while video continued. It stopped at the overlap assertion: the two tools in a DSH batch ran sequentially and returned `M0_OK,NO_LEASE`, not `BUSY,M0_OK`. The [official scheduler](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/core/tools/src/pipeline.ts#L98-L113) serializes tools that don't declare concurrency safety. The updated test keeps the real DSH operation in flight and issues a second standard MCP `tools/call` in the same authenticated session from the DSH container. It requires `BUSY` before takeover, `HANDOVER` during the drain, and no renderer effects for either denied request.

## Observed result

The [job at `2fbed01`](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/job/135367748850) ran all the scenarios below. It exited **1** at the final held pointer assertion. The [log artifact](https://github.com/sagehou/dsh-workstation/actions/runs/44467202793/artifacts/14502827811) includes the full output. The GitHub Actions job remains red.

| Assertion | Actual result |
| --- | --- |
| CDP and control isolation | **Pass.** Only Chromium and the Provider own CDP bridge endpoints; the relay shares Chromium's namespace. Direct host, DSH, and viewer bridge connections to CDP failed. DSH also could not reach the Provider or Selkies control endpoints. Its accessible MCP listener rejected an unauthenticated request. |
| Lease and owner | **Pass.** The official DSH process wrote a marker in the existing Chromium context with a valid lease. An unleased call returned `NO_LEASE`; a different DSH session with the current generation returned `NOT_OWNER`. Two simultaneous grant requests produced one grant and one `NOT_HUMAN`. Raw keyboard and button frames did not reach Chromium in Agent mode, while the same Selkies socket delivered new frames. |
| Concurrent calls and takeover | **Pass.** The same owner got `BUSY` for an overlapping call and `HANDOVER` for a new call once takeover began. Neither reached the renderer. The held CDP operation finished while human input was still blocked. The Provider then revoked the lease, and Chromium observed keyboard and mouse events from the same Selkies connection again. |
| Expiry and stale generation | **Pass.** The `4500 ms` lease expired during a real held operation. Admission closed while the renderer drained and video continued. The prior generation could not call with no lease, or after a fresh grant to the same DSH session (`STALE_GENERATION`). |
| DSH disconnect and restart | **Pass.** `docker compose kill -s SIGKILL dsh` closed the MCP event stream. The Provider held the input lock until the renderer settled. On restart the spent transport credential could not initialize; the same persisted DSH session resumed with a new credential and required a fresh lease. |
| Chromium disconnect and restart | **Pass.** `docker compose kill -s SIGKILL chromium` interrupted the held renderer operation. No completion marker appeared; the Provider entered `DISCONNECTED` without a lease and denied further MCP operations. An explicit recovery against the restarted browser and a fresh generation were required for a new tool call. |
| Provider disconnect and restart | **Pass.** After `docker compose kill -s SIGKILL provider`, the original Selkies connection still streamed with key/button input blocked, even as the existing renderer operation went on to finish. On restart, the persisted fence caused `RESET_NEEDS_NEW_BROWSER` for the same Chromium process. Explicit recovery after Chromium replacement and a new MCP lease succeeded. |
| Input already held before grant | **Fail.** While in HUMAN, a raw mouse-down reached Chromium. Selkies switched to `MK_ACCESS,0` and dropped the subsequent release frame. The Provider granted a lease and performed an Agent action without Chromium having received the mouse-up. After takeover returned to HUMAN, the release frame reached Chromium. |

The final log ends with:

```text
AssertionError [ERR_ASSERTION]: Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update
```

## Decision

The independent Provider proved server-side lease enforcement through official MCP for DSH ACP sessions and passed the tested Agent-to-Human drain and recovery cases. **Gate C remains blocked** on the Human-to-Agent transition. The pinned Selkies [token reconciliation](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L8297) announces the new authority on the existing connection; [release of held input](https://github.com/selkies-project/selkies/blob/d6b9351421bd503ffa89bdee78e2bce758b1ffe5/src/selkies/websockets_mode.py#L3103) belongs to its disconnect path. Before granting Agent control, the integration needs a supported way to quiesce prior human input, release held devices, and confirm completion. Discarding new frames is insufficient. That is an architecture blocker; this experiment does not add an input proxy or substitute a UI toggle.

The tested boundary is a single Provider on the pinned Docker topology with WebSocket Selkies and non-keyboard/mouse peripherals and transfers disabled. The trusted ACP driver supplies the per-session credential. The experiment does not establish how the DSH Web Profile would bind those credentials to live Sessions, run the upstream Playwright MCP Browser Use package under a lease, or verify network partitions and host power loss. Gate D still waits for upstream native floating maximize/restore and retains its iframe lifecycle criteria. No change to accepted ADRs or authorization to start M1 follows from this experiment.

Evidence recorded 2026-11-19 UTC.
