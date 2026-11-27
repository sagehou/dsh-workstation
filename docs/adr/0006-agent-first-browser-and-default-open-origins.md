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

`mcp__browser__lease_status` acquires an available lease through `browser-gate`.
An active lease stays with its DSH session. Action tools require that session's
current generation before they can renew the lease or send browser input.
Operators can still grant, take over and revoke from the control page.

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

The `AGENTS.md` baseline now states the same rule, so there is no longer an
override to record. The product owner confirmed on 2026-11-27 that this
single-operator deployment does not require an SSRF or egress policy.

## Consequences

### Accepted risks

- **The lease is no longer an approval.** It still serialises ownership and still
  gates input, but it no longer expresses "the operator permitted this".

### Not required for this deployment

An SSRF or browser egress policy is out of scope. One operator drives one
Chromium against one deployment; the Agent browsing `169.254.169.254`, an RFC1918
service, the Provider's control listener or the Docker host is the same trust
boundary the operator already has, so blocking those destinations would add a
gate without removing an attacker. A deployment that later serves more than one
operator would need to revisit this, because the boundary that makes it
acceptable here is the single-tenant one.

### What still holds

- Every browser tool call passes the lease, session, generation and
  in-flight-operation checks.
- The input gate remains the boundary for human input; a takeover releases held
  input through it before authority changes.
- Non-HTTPS schemes and URLs carrying credentials are still refused.

### Follow-up

No follow-up is required for the first release. Issue #11 is closed as out of
scope for a single-operator deployment; it would reopen only if this deployment
ever serves more than one operator.

## Related

- [ADR-0004](0004-single-user-release-and-deferred-sidebar.md) — single-user
  baseline; its "keep Agent control disabled" clause is superseded here.
- [ADR-0005](0005-release-held-input-at-selkies.md) — the input gate this ADR
  keeps; its human-first lease default is superseded here.
- [#29](https://github.com/sagehou/dsh-workstation/issues/29) — the product-model
  change this ADR records.
- [#30](https://github.com/sagehou/dsh-workstation/issues/30) — the product-model
  change this ADR records alongside #29.
