# ADR-0002: Shared Selkies Chromium for Human and Agent

English · [简体中文](0002-shared-selkies-chromium.zh-CN.md)

Status: Accepted, subject to M0 proof

## Context

The workstation needs a full human-operated browser and Agent browser automation with the same login state, tabs, cookies, and profile.

## Decision

- Run one LinuxServer Chromium container with Selkies and one persistent browser profile.
- Human interaction uses Selkies at same-origin `/browser/`.
- Agent automation attaches to the existing Chromium process via CDP/Playwright.
- Do not launch a second browser for Agent automation.
- Do not expose CDP on host/public interfaces.
- Use exclusive server-side browser leases.
- Human input must be gated at the Selkies input boundary during Agent ownership.

## Consequences and validation gates

- Playwright CDP limitations must be tested against the pinned Chromium version.
- Selkies subpath, iframe CSP, WebSocket, and Traefik behavior must be verified.
- Exclusive mode is not considered implemented unless both Agent commands and Selkies human input are actually gated.
- If Selkies cannot support input gating without a maintained integration layer, stop and request an architecture decision. Do not fake exclusivity with UI state.
