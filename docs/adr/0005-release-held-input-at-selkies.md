# ADR-0005 — Release held browser input at the Selkies boundary

- Status: Accepted
- Date: 2026-11-23
- Supersedes: nothing
- Related: [ADR-0002](0002-shared-selkies-chromium.md), [#4](https://github.com/sagehou/dsh-workstation/issues/4), [M0 Provider evidence](../roadmap/M0-provider-evidence.md)

## Context

One operator and the Agent share one Chromium process ([ADR-0002](0002-shared-selkies-chromium.md)). Under [ADR-0004](0004-single-user-release-and-deferred-sidebar.md) the Agent's browser control stays disabled until exclusive handoff passes #4.

M0 established the hard part. Selkies gates *newly submitted* input correctly: while the Agent holds the lease, raw keyboard and mouse frames sent over the WebSocket never reach the renderer, and video keeps flowing on the same socket. Gate C still failed on one specific case, and the recorded assertion is exact:

```text
AssertionError [ERR_ASSERTION]: Gate C BLOCKED: a mouse button held before grant was not released by the live Selkies token update
```

A mouse button pressed while HUMAN held control stayed pressed after authority moved to the Agent, because **the release frame that the browser sent afterwards was dropped by the gate along with every other input frame**. It arrived only when control returned to HUMAN. So the desktop spent the Agent's whole lease in the middle of a drag the Agent never started.

This is not a UI problem. A front-end toggle cannot fix it: the state that is stuck lives in the desktop input backend on the server side, and the client that could send the release has already lost permission to send anything.

## What the pinned upstream actually does

Verified against the exact pinned Selkies `2.2.1` (`d6b9351421bd503ffa89bdee78e2bce758b1ffe5`), not from memory:

| Fact | Evidence |
| --- | --- |
| Authority is announced as `MK_ACCESS,1` / `MK_ACCESS,0`. | `websockets_mode.py:5312` (handshake), `:8356` (reconcile) |
| Revoking authority does **not** close the socket when only mk-control changes; only a token revocation or a role change closes it. | `reconcile_clients()` at `:8298`; `should_disconnect` is set only for `not new_perms` or `old_role != new_role` |
| The primitive that releases held input exists and is correct. | `_release_held_input()` at `:3103` calls `release_mouse_buttons()` and `reset_keyboard()` |
| It is called on only two paths: socket teardown, and the reconnect-grace expiry. Neither runs when authority is revoked but the socket stays open. | `:6303`, `:6382` |
| The upstream docstring states the release is deliberately conditioned on *departing* authority, not on losing it. | `ws_handler()` docstring, `:5172` |
| No setting exposes release-on-authority-loss; `enable_collab` and the token table role/slot are the only knobs. | `settings.py`, `sessions._mk_access_verdict()` at `:88` |

So the upstream behaviour is internally consistent: it assumes losing mk-control means a *departing* client, and it ties release to departure. The gap this leaves is precisely the case M0 exercised — authority removed while the connection stays alive.

## Decision

Do **not** fork or patch Selkies. Rebuild the missing transition in a small maintenance layer at the input boundary, called `browser-input-gate`.

### The ordering this hinges on

A release cannot be sent *after* authority is revoked. Authority is re-evaluated from the live token table on every input frame (`websockets_mode.py:6235-6237`), and `provision_tokens()` installs the new table *before* `reconcile_clients()` pushes `MK_ACCESS,0` (`:8071-8072`, `:8356`). So by the instant a client learns it lost authority, the frames that would release its held input are already being dropped. That is exactly the M0 failure, restated from the server's point of view.

The release therefore has to happen **while the socket still holds authority**, and the sequence is owned by whoever flips the table.

1. **The gate is the WebSocket peer Selkies sees.** The operator's browser connects to it; it connects upstream to Selkies. It is a real server-side boundary, not a client-side control, and no page can bypass it by sending frames directly.

2. **It releases with upstream's own two primitives, not by tracking state.** The release is `kr` followed by `m,0,0,0,0,<seq>`. `kr` dispatches `reset_keyboard()`, which releases *every* held key and normalizes a stuck modifier (`input_handler.py:9252-9256`); a zero-delta relative pointer message with an empty button mask takes the same path as `release_mouse_buttons()`, which is literally `send_x11_mouse(0, 0, 0, 0, relative=True)` (`:5885-5888`). Upstream's own release is those two calls, so this reproduces it instead of approximating it — and it covers keys the gate never saw, which a gate-side tracking set could not.

3. **The gate proves the release was applied before returning.** The data socket's read loop is a single sequential `async for msg in websocket` (`websockets_mode.py:5420`) that *awaits* each input message's dispatch (`:6248`), and it answers a WebSocket PING inline with `await websocket.pong()` (`:5421-5423`, since `autoping=False`). Sending the two release frames and then a PING therefore proves they were dispatched when the PONG comes back: same connection, FIFO, awaited handler. The gate uses that as its completion barrier, with a bounded timeout.

   A pointer echo would *not* have worked as the barrier, which is worth recording because it looks like it should: the echo is suppressed when the pointer is already drawn at the new position (`input_handler.py:2013-2016`), and a zero-delta release leaves the pointer exactly where it was — so the echo is silent in precisely the held-drag case the barrier exists for.

   The barrier proves *dispatch on this connection*, not authorisation, and the difference is load-bearing. On a socket that has already lost authority the release frames are dropped at `:6235` while the PING behind them is still answered inline, so a handover there would confirm a release that never happened. A handover is therefore refused unless the socket currently holds authority, or provably never held any: a connection the gate forwarded nothing for cannot have left anything down.

   A release that cannot be proven is remembered as unproven rather than treated as done. The desktop's held state is global, so a page having reconnected says nothing about a press the gate failed to clear; the refusal persists until some later handover actually proves a release. In practice the page reconnects on its own, Selkies re-grants from the unchanged token table, and that handover proves it.

4. **It closes operator input at that same instant, not when `MK_ACCESS,0` arrives.** Between the release and the table flip, upstream still accepts the operator's frames. If a new press landed in that window it would be stranded by the flip. The gate therefore stops forwarding operator input as soon as it starts releasing, so the interval contains no client frames at all, and `MK_ACCESS,0` arriving later is confirmation rather than the trigger.

5. **`MK_ACCESS,1` reopens input.** Hand-back is the reverse transition and needs no release: the gate has been holding input closed, so nothing was held when the Agent stopped. It reopens only on that explicit verdict, so a grant that arrives while a release is still outstanding is refused.

   If the release barrier times out, the gate does not fail open and does not report success. It closes the operator's upstream socket **while that socket still holds authority**, which makes Selkies run its own `_release_held_input()` on the departure path (`:6303`), and reports the handover as refused so the Provider does not issue the lease. That departure release is expected but unproven, which is why the refusal outlives the socket.

6. **It forwards the operator's handshake untouched.** Selkies authorises the socket itself, from the session token in the `selkies.token.<base64url>` subprotocol, and checks the `Origin` against the `Host` it receives (`stream_server.py:2408-2442`). The gate passes `Host`, `Origin` and the subprotocol through unchanged, so it is never the authority; rewriting any of them would make Selkies reject the operator's own page.

6. **Fail closed.** Lease expiry, Provider crash, upstream disconnect, gate crash, a malformed frame, or a release that never clears its barrier all end as *input not forwarded*. The gate forwards operator input only when it holds a current `MK_ACCESS,1` and is not mid-release.

### The control plane

The transition owner calls the gate before it touches the token table:

| Call | Meaning |
| --- | --- |
| `POST /handover` | Close operator input, release what is held, wait for the barrier. `200` means held input is provably released. Any other answer means the flip must not proceed. |
| `POST /resume` | Reopen operator input. |

Provider `input(true)` becomes `POST /handover` **then** the revoking token table; `input(false)` becomes the restoring table **then** `POST /resume`. If `/handover` fails, the Provider fails the grant and keeps the lease unissued — the previous behaviour of merely flipping the table is what left the desktop mid-drag.

## Why not the alternatives

| Option | Rejected because |
| --- | --- |
| UI toggle that disables input before handoff | The requirement is enforcement at the Selkies input boundary. A toggle is advisory: the browser can still send frames, and a second tab or a crafted client bypasses it entirely. |
| Close and reopen the socket on every handoff | It would release held input as a side effect, but it also drops video, forces a re-handshake, and gives the operator a visible reconnect on every single transfer. It also makes the Agent's lease begin with a black frame. |
| Patch Selkies to call `_release_held_input()` in `reconcile_clients()` | It is the cleanest fix and belongs upstream. Under AGENTS.md and #4's own constraint the product must not fork the core; this remains a candidate upstream contribution. Note it would not be sufficient on its own: `reconcile_clients()` runs *after* the table is installed, so a release there is a release after revocation, which is the order that does not work. The upstream fix that would retire this gate is a release *before* the table is installed. Recorded as a follow-up rather than silently relied upon. |
| Rely on the reconnect grace to release | The grace is a *departure* path and needs the socket to be gone. Authority revocation leaves the socket alive by design, so the grace never starts. |

## Consequences

- Agent browser control stays disabled until this gate passes the full state-transition matrix: HUMAN→AGENT, AGENT→HUMAN, lease expiry, client disconnect, Chromium restart, concurrent input during handoff, and Provider abnormal exit.
- The gate becomes a component that must be built, tested and deployed, and it is on the video path for the operator. Its failure modes have to be the closed ones above.
- Because it is a WebSocket peer, its own correctness is testable without a human: inject frames over a real connection and assert what reaches the renderer, the same way the M0 experiment did.
- If the upstream release-on-authority-loss lands, most of this gate's logic deletes and it becomes a thin pass-through. Its tests stay useful either way.

## Unverified

- The gate now runs on the live stack: a press held on the operator's real Selkies socket, handed over, reads back from the Agent's tab as one press and one release. Removing the handover call makes the same probe report a press with no release, so the check is not passing by construction. The failure-mode matrix around it is still covered by the fake upstream rather than measured.
- The PING/PONG barrier is argued from the pinned source, not measured. The argument depends on the read loop awaiting each input dispatch before reading the next frame; if that changes, the barrier weakens and must be re-examined rather than assumed.
- The full transition matrix on a real host (HUMAN→AGENT, AGENT→HUMAN, lease expiry, client disconnect, Chromium restart, concurrent input during handoff, Provider abnormal exit) has not been run. It is the gate's acceptance test, not a follow-up.
- Only keyboard and mouse are in scope; file transfer, clipboard, gamepad, microphone and webcam are already disabled in Compose. The emitter and the scroller (`co`, `cmd`, `sf`, `sfe`) ride the same authority gate but are not released by `kr` or a pointer mask, so they are dropped while input is closed instead.
- Whether releasing on authority loss has any effect on a client that is legitimately still a controller on another display is unexamined; this deployment uses one display.
