// Client half of the Workstation sidebar Bundle.
//
// Written in the shape the DSH client-module loader expects, not as a plain ES
// module: the loader fetches this outside Vite's module graph and calls
// `window.__ModuleLoader__.load({ id, factory })`, resolving every external
// through the injected `require` (the frozen platform module table). A bare
// `import ... from 'react'` cannot work — the browser has no import map. The
// banner/intro/footer mirror `packages/client/tsdown.client.ts:932-935`.
//
// Docked-only is the design, not a limitation worked around: `keepMounted` is
// honoured only for the docked seat (`shell.tsx:208` reads
// `seat === 'sidebar.right.pane.tab' && keepMounted === true`). In that seat
// `hide()` collapses the column instead of removing the tab (`service.ts:584`
// runs `toggleExpanded()`, not `close()`), so the browser keeps its context
// across hide/show, tab switches and Session changes.
//
// This module deliberately keeps `apply` to registration only. An exception
// anywhere in it fails the fiber and the whole tab disappears ("web boot: 1 entry
// did not activate"), which is a much worse outcome than a missing convenience.
// The auto-dock guard lives outside; see #5.
window.__ModuleLoader__.load({
  id: 'dsh-workstation-sidebar',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;

    const { createElement, useEffect, useState } = require('react')

    const ID = 'dsh-workstation-sidebar'
    const KIND = 'workstation-browser'
    const TITLE = '浏览器'

    // The frame must go through /_auth/browser, not /browser/ directly.
    //
    // Selkies authenticates its data socket with a `selkies.token.<base64url>`
    // subprotocol, and the page builds that subprotocol from the token in its own
    // URL fragment. `/browser/` alone carries no token, so the page offers no
    // subprotocol, Selkies answers 401 to every upgrade, and the pane sits on
    // "WebSocket disconnected. Attempting to reconnect…" forever. Measured here:
    // the gate logged `count: 0, kinds: "none"` on every attempt while Host and
    // Origin were correct, and the browser's WebSocket request carried no
    // Sec-WebSocket-Protocol header at all.
    //
    // `/_auth/browser` is the Gateway's own entry point: it checks the session and
    // answers 303 to `/browser/#token=<controller token>`. The iframe is pointed at
    // it directly and the *browser* follows the redirect, because the fragment has
    // to survive. An earlier version resolved the Location with
    // `fetch(..., { redirect: 'manual' })`; that returns an opaqueredirect response
    // whose headers are unreadable by spec, so the token was silently dropped and
    // the frame fell back to a bare `/browser/`.
    //
    // Same origin, so `frame-ancestors 'self'` on the Selkies response is satisfied.
    const SRC = '/_auth/browser'

    // The pane has to say who is driving. Without it a takeover is invisible: the
    // page simply stops responding to the operator while the Agent types into it.
    // The banner is part of the frame's own layout so it cannot be hidden by the
    // page it is warning about.
    // Ends an Agent lease from the operator's side. The CSRF token lives in the
    // shell's meta tag; without it the Gateway rejects the POST, which is the
    // correct behaviour and is reported rather than swallowed.
    async function takeOver () {
      const meta = document.querySelector('meta[name="csrf-token"]')
      const token = meta?.getAttribute('content') ?? ''
      try {
        const r = await fetch('/_auth/control/takeover', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: '{}',
        })
        if (!r.ok) console.warn('[workstation-sidebar] takeover refused:', r.status)
        // The poller reports the new state; nothing to update here.
      } catch (error) {
        console.warn('[workstation-sidebar] takeover failed:', error?.message ?? error)
      }
    }

    // Start/stop the recording. `/ _auth/control/record` takes a fixed action enum
    // and the session CSRF token, so this cannot be driven from another origin.
    async function toggleRecording () {
      const meta = document.querySelector('meta[name="csrf-token"]')
      const token = meta?.getAttribute('content') ?? ''
      const action = recordingActive ? 'stop' : 'start'
      try {
        const r = await fetch('/_auth/control/record', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-CSRF-Token': token,
          },
          body: 'action=' + action,
        })
        if (!r.ok) console.warn('[workstation-sidebar] recording ' + action + ' refused:', r.status)
      } catch (error) {
        console.warn('[workstation-sidebar] recording ' + action + ' failed:', error?.message ?? error)
      }
    }

    function BrowserBody() {
      const state = useProviderState()
      const agent = state === 'AGENT'
      const [, forceRender] = useState(0)
      // The poller mutates `recordingActive` without going through React, so the
      // toolbar needs a nudge to repaint when it changes.
      useEffect(() => subscribe(() => forceRender(n => n + 1)), [])
      return createElement('div', {
        style: { position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' },
      },
      // Always-visible toolbar: the recording state must be readable whether or
      // not the Agent holds the lease (#31).
      createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: '8px', flex: '0 0 auto',
          padding: '4px 8px', background: '#1f1f1f', color: '#e6e6e6', fontSize: '12px',
        },
      },
      createElement('button', {
        type: 'button',
        onClick: toggleRecording,
        title: recordingActive ? '停止录制' : '开始录制',
        style: {
          padding: '2px 10px', fontSize: '12px', cursor: 'pointer', borderRadius: '3px',
          border: '1px solid ' + (recordingActive ? '#e5484d' : '#666'),
          background: recordingActive ? '#e5484d' : 'transparent',
          color: '#fff', fontWeight: '600',
        },
      }, recordingActive ? '■ 停止录制' : '● 录制'),
      createElement('span', { style: { color: '#999' } },
        recordingActive ? '正在录制人与 Agent 的浏览器操作' : '未录制')),
      agent ? createElement('div', {
        // High contrast on purpose: this is the one thing that must be noticed
        // while the operator's input is being refused.
        style: {
          background: '#b3261e', color: '#fff', padding: '6px 10px',
          fontSize: '13px', fontWeight: '600', display: 'flex',
          alignItems: 'center', gap: '8px', flex: '0 0 auto',
        },
        role: 'status', 'aria-live': 'polite',
      }, '● Agent 正在控制浏览器 —— 你的输入不会生效',
      // The operator must be able to end a takeover without hunting for the
      // control page. `/ _auth/control/takeover` is the JSON counterpart of that
      // page's button and requires the session CSRF token, which the shell puts in
      // a meta tag.
      createElement('button', {
        type: 'button',
        onClick: takeOver,
        style: {
          marginLeft: 'auto', padding: '3px 10px', fontSize: '12px',
          fontWeight: '600', cursor: 'pointer', borderRadius: '3px',
          border: '1px solid #fff', background: 'transparent', color: '#fff',
        },
      }, '强制接手')) : null,
      createElement('iframe', {
        src: SRC,
        title: TITLE,
        allow: 'clipboard-read; clipboard-write; fullscreen',
        style: {
          border: agent ? '2px solid #b3261e' : '0',
          boxSizing: 'border-box',
          width: '100%', flex: '1 1 auto', display: 'block', background: '#000',
        },
      }))
    }

    // One poller for the whole module: the banner and the auto-open both need the
    // Provider state, and two intervals would double the requests for the same
    // fact. Subscribers are notified on change only, so a steady state costs one
    // fetch per tick and no renders.
    const listeners = new Set()
    let providerState
    let recordingActive = false
    let pollTimer

    function publish (status) {
      // The Gateway serialises `browserStatus` with Go's default field names, so
      // the JSON keys are `State`/`Reason`, not `state`. Reading the lowercase
      // form silently yielded `undefined` and the banner never appeared.
      const next = status?.State ?? status?.state
      // Recording state travels with the same poll (#31); it is a separate flag
      // because it is independent of who holds the lease.
      recordingActive = status?.record?.active === true
      if (next === providerState) return
      providerState = next
      for (const listener of [...listeners]) {
        try { listener(next) } catch { /* one bad subscriber must not stop the rest */ }
      }
    }

    let lastPollError
    async function pollOnce () {
      try {
        const r = await fetch('/_auth/control/state', { credentials: 'same-origin' })
        if (!r.ok) {
          // Surface the status once per distinct value. A silent 401 here is what
          // made "the banner never appears" indistinguishable from "the poll never
          // runs", and that cost a round of guessing.
          const note = 'HTTP ' + r.status
          if (note !== lastPollError) {
            lastPollError = note
            console.warn('[workstation-sidebar] control/state poll failed:', note)
          }
          return
        }
        lastPollError = undefined
        publish(await r.json())
      } catch (error) {
        const note = String(error?.message ?? error)
        if (note !== lastPollError) {
          lastPollError = note
          console.warn('[workstation-sidebar] control/state poll failed:', note)
        }
      }
    }

    function subscribe (listener) {
      listeners.add(listener)
      if (pollTimer === undefined) {
        void pollOnce()
        pollTimer = setInterval(pollOnce, 3000)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && pollTimer !== undefined) {
          clearInterval(pollTimer)
          pollTimer = undefined
        }
      }
    }

    function useProviderState () {
      const [state, setState] = useState(providerState)
      useEffect(() => subscribe(setState), [])
      return state
    }

    function apply(ctx) {
      // `guide` needs `id`: it is the entry's identity within this provider and
      // has no default (`tab-registry.ts:66`). Omitting it fails activation — the
      // failure M0 recorded and this file hit again.
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: ID,
        kind: KIND,
        keepMounted: true,
        title: () => TITLE,
        guide: [{
          id: KIND,
          order: 50,
          title: () => TITLE,
          description: () => '共享 Chromium 桌面，与独立浏览器页面同一实例',
        }],
      }), 'workstation browser type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: ID },
        BrowserBody,
      )), 'workstation browser body')

      // Agent-first (#29): when the Agent takes the lease, the tab must already be
      // on screen. Otherwise the Agent drives a page nobody can see, which is the
      // case that made every tool call look like it worked while the operator
      // watched an empty pane.
      ctx.effect(() => {
        let wasAgent = false
        return subscribe(state => {
          const isAgent = state === 'AGENT'
          if (isAgent && !wasAgent) {
            // `sidebarRight` is injected, so it must be present here. Report a
            // missing `openTab` rather than swallowing it: a silent failure is
            // what made "the pane never opened" look like a UI bug.
            if (typeof ctx.sidebarRight?.openTab !== 'function') {
              console.warn('[workstation-sidebar] sidebarRight.openTab is unavailable; cannot auto-open the pane')
              return
            }
            try { ctx.sidebarRight.openTab(KIND) } catch (error) {
              console.warn('[workstation-sidebar] auto-open failed:', error?.message ?? error)
            }
          }
          wasAgent = isAgent
        })
      }, 'workstation browser auto-open')
    }

    module.exports = {
      name: 'workstation-sidebar-client',
      inject: ['sidebarRightTabs', 'sidebarRight', 'slots'],
      apply,
    }
    return module.exports; } });
