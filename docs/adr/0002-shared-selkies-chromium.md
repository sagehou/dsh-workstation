# ADR-0002 — Shared Selkies Chromium for human and Agent

English · [简体中文](0002-shared-selkies-chromium.zh-CN.md)

**Accepted pending M0 proof**

## Context

Human interaction and Agent browser automation need to share login state, tabs, cookies, and profile.

## Decision

| Area | Choice |
| --- | --- |
| Browser | One LinuxServer Chromium container with Selkies and one persistent profile. |
| Human access | Selkies at same-origin `/browser/`. |
| Agent access | Attach through CDP/Playwright to the existing process. Keep CDP off host and public interfaces. |
| Ownership | Exclusive server-side leases. Gate human input at the Selkies boundary during Agent ownership. |

## Consequences and validation gates

- Verify Playwright's CDP limits, the Selkies subpath, iframe CSP, WebSockets, and Traefik on the pinned versions.
- Verify enforcement against both Agent calls and real human input before claiming exclusive mode.
- If reliable input gating needs a maintained integration layer, stop for an architecture decision. UI state cannot substitute for enforcement.

[M0 results](../roadmap/M0-evidence.md#b--one-browser-process-and-profile) · [Exclusive control results](../roadmap/M0-provider-evidence.md#observed-result)
