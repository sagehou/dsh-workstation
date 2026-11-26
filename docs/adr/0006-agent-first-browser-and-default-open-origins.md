# ADR-0006 — Agent-first browser control and default-open origin policy

**Accepted — 2026-11-26.** This ADR supersedes specific clauses of
[ADR-0004](0004-single-user-release-and-deferred-sidebar.md) and
[ADR-0005](0005-release-held-input-at-selkies.md), and overrides one rule in
`AGENTS.md`. It records a product decision, not a measurement.

## Context

ADR-0005 assumed the operator is the default owner of the shared browser: the
Agent could only act after the operator pressed *grant* on the control page, and
`NO_LEASE` was the correct answer to any tool call made without one.

That assumption did not survive first use. Every Agent task began with a manual
step, and a task that ran unattended stopped at the first call. The product owner
reversed the model on 2026-11-26:

> Agent 可以抢；如果浏览器标签没有展开，要能自动展开；浏览器以 Agent 使用为优先场景，
> 人工介入只是附加场景。

A second decision followed: the origin allowlist stays configurable, but its
default becomes "allow everything", not "allow nothing".

## Decisions

### 1. The Agent is the default owner of the browser

A browser tool call takes the lease itself when no live lease is held. The
operator's control page remains able to grant, take over and revoke, but those
are no longer a precondition for Agent work.

`AGENTS.md` says *"Keep Agent browser control disabled until exclusive input
handoff passes its acceptance criteria."* **This ADR overrides that clause.** The
input gate itself is unchanged and still sits in the path — a takeover drains the
previous owner and releases held input before authority moves.

### 2. The sidebar tab opens itself when the Agent takes control

A takeover that happens in a tab nobody can see is indistinguishable from a
takeover that did not happen. The client polls `/_auth/control/state` and opens
the tab on the HUMAN→AGENT edge.

### 3. Closing the last tab must not stop Chromium

Chromium exits when its last tab closes, which destroys the shared profile and
forces a reconnect. Neither Selkies nor the LinuxServer image exposes a keep-alive
switch, so the Provider watches the context and opens a replacement page. This is
a workaround for upstream behaviour, recorded as such.

### 4. Tab binding follows intent, not position

A call may carry `intent` (a URL host or title fragment). A live tab matching it
is bound, so a follow-up continues where it started; otherwise a new tab is
opened. **No tab is ever closed to make room.**

### 5. `BROWSER_TOOL_ORIGINS` is default-open

Unset, or the literal `*`, means every HTTPS origin is allowed. A configured list
still restricts to exactly those origins.

**This overrides the `AGENTS.md` rule:** *"Keep broad browsing of untrusted sites
disabled until browser egress controls are independently enforced and tested.
`BROWSER_TOOL_ORIGINS` is not an egress firewall or complete SSRF defense."*

The product owner accepted the risk explicitly, in those words, on 2026-11-26.

## Consequences

### Accepted risks

- **The egress rule is now unenforced.** `BROWSER_TOOL_ORIGINS` was never a
  firewall, and with default-open it is not even an allowlist. Nothing stops
  Chromium from reaching `169.254.169.254`, RFC1918 services, the Provider's own
  control endpoints, or the Docker host.
- **The Agent can drive the browser into the deployment's own services.** The
  Provider control listener and the input gate are reachable from the Chromium
  network. A page that the Agent navigates to can attempt those requests; the
  credentials live in `/run/secrets` inside containers Chromium does not mount,
  so the immediate impact is limited to unauthenticated endpoints, but this is
  defence by accident rather than by design.
- **The lease is no longer an approval.** It still serialises ownership and still
  gates input, but it no longer expresses "the operator permitted this".

### What still holds

- Every browser tool call passes the lease, session, generation and
  in-flight-operation checks.
- The input gate remains the boundary for human input; a takeover releases held
  input through it before authority changes.
- Non-HTTPS schemes and URLs carrying credentials are still refused.

### Follow-up

Issue #30 tracks the deployment controls that would make default-open survivable
(network-level egress policy, a deny list for metadata and RFC1918, and a
decision on whether the Provider control endpoints should be reachable from the
Chromium network at all). Issue #11 remains open and is now a hardening item
rather than a release gate.

## Related

- [ADR-0004](0004-single-user-release-and-deferred-sidebar.md) — single-user
  baseline; its "keep Agent control disabled" clause is superseded here.
- [ADR-0005](0005-release-held-input-at-selkies.md) — the input gate this ADR
  keeps; its human-first lease default is superseded here.
- [#29](https://github.com/sagehou/dsh-workstation/issues/29) — the product-model
  change this ADR records.
- [#30](https://github.com/sagehou/dsh-workstation/issues/30) — the hardening work
  the override makes necessary.
- [#11](https://github.com/sagehou/dsh-workstation/issues/11) — browser egress
  policy, now hardening rather than a gate.
