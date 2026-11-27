// Injected into every page of the shared Chromium to record what the operator
// does. The shape follows TencentCloud/octop-browser's
// `src/octop_browser/record/injected/recorder.js` (MIT): a capture-phase listener
// per event, a selector-candidate list per target, and delivery over a
// Runtime binding rather than polling.
//
// Differences from that implementation, and why:
//
//   - It records the *operator's* input on a browser the Agent may also be
//     driving. `isTrusted` is the discriminator: CDP `Input.dispatchMouseEvent`
//     produces untrusted events, so the Agent's synthetic clicks do not land in
//     the human timeline. Agent actions are recorded on the Provider side instead,
//     where the tool name and generation are known.
//   - Password inputs are never read. Octop masks by policy after the fact; here
//     the value is dropped at capture, so it cannot reach a file even if the
//     policy were misconfigured later.
//   - Every send is wrapped: a recorder that throws must not break the page the
//     operator is using.
(() => {
  const CONFIG = globalThis.__WORKSTATION_RECORDER__ || {}
  if (CONFIG.disabled === true) return
  if (globalThis.__workstationRecorderInstalled === true) return
  globalThis.__workstationRecorderInstalled = true

  const BINDING = CONFIG.bindingName || '__workstationRecord'
  const send = payload => {
    try {
      const binding = globalThis[BINDING]
      if (typeof binding !== 'function') return
      binding(JSON.stringify(payload))
    } catch {
      // A recorder failure must never reach the page.
    }
  }

  const now = () => Math.round(performance.timeOrigin + performance.now())

  // Ordered from most to least stable. `selectorCandidates` is what replay tries
  // in order; the first that still resolves wins.
  function selectorCandidates(el) {
    const out = []
    const push = value => {
      if (typeof value === 'string' && value.trim() !== '' && !out.includes(value)) out.push(value)
    }
    if (el.id) push('#' + CSS.escape(el.id))
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label', 'placeholder']) {
      const value = el.getAttribute?.(attr)
      if (value) push(`${el.tagName.toLowerCase()}[${attr}="${CSS.escape(value)}"]`)
    }
    const role = el.getAttribute?.('role')
    if (role) push(`${el.tagName.toLowerCase()}[role="${CSS.escape(role)}"]`)
    // A short structural path, bounded so a deep DOM cannot produce a 10 KB string.
    const path = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth += 1) {
      let step = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const index = Array.prototype.indexOf.call(parent.children, node) + 1
        step += `:nth-child(${index})`
      }
      path.unshift(step)
      node = node.parentElement
    }
    if (path.length > 0) push(path.join(' > '))
    return out
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return null
    const text = (el.innerText || el.textContent || '').trim().slice(0, 120)
    return {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || '',
      name: el.getAttribute('name') || '',
      accessibleName: el.getAttribute('aria-label') || text,
      text,
      label: el.labels?.[0]?.innerText?.trim().slice(0, 120) || '',
      placeholder: el.getAttribute('placeholder') || '',
      id: el.id || '',
      nameAttr: el.getAttribute('name') || '',
      type: (el.getAttribute('type') || '').slice(0, 40),
      testId: el.getAttribute('data-testid') || '',
      selectorCandidates: selectorCandidates(el),
    }
  }

  // The one rule that must hold regardless of policy: a password never leaves the
  // page, not even masked.
  const isSecret = el =>
    el instanceof HTMLInputElement &&
    (el.type === 'password' || /password|passwd|secret|token|otp|code/i.test(el.name || el.id || ''))

  function valueOf(el) {
    if (isSecret(el)) return { masked: true, length: String(el.value ?? '').length }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // `mask-sensitive` default: emails and long digit runs are masked, matching
      // octop-browser's policy name.
      const value = String(el.value ?? '')
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { masked: true }
      if (/^\d{11,}$/.test(value)) return { masked: true }
      return { value: value.slice(0, 2000) }
    }
    return {}
  }

  function emit(type, el, extra) {
    send({
      type,
      at: now(),
      url: location.href,
      target: describe(el),
      ...(extra || {}),
    })
  }

  const onClick = event => {
    // Synthetic events come from CDP (the Agent). Keeping them out of the human
    // timeline is what makes "who did this" answerable later.
    if (event.isTrusted !== true) return
    emit('click', event.target, { button: event.button, x: event.clientX, y: event.clientY })
  }
  const onDblClick = event => {
    if (event.isTrusted !== true) return
    emit('dblclick', event.target)
  }
  const onInput = event => {
    if (event.isTrusted !== true) return
    emit('input', event.target, valueOf(event.target))
  }
  const onChange = event => {
    if (event.isTrusted !== true) return
    emit('change', event.target, valueOf(event.target))
  }
  const onSubmit = event => {
    if (event.isTrusted !== true) return
    emit('submit', event.target)
  }
  const onKeyDown = event => {
    if (event.isTrusted !== true) return
    // The key itself is recorded; the value of the field it types into is not,
    // except through the `input` event above.
    emit('keydown', event.target, { key: String(event.key || '').slice(0, 32) })
  }

  // Scroll is coalesced: raw scroll fires per frame and would bury every other
  // event in the timeline.
  let scrollTimer
  let scrollSent = 0
  const onScroll = event => {
    if (event.isTrusted !== true) return
    const at = now()
    if (at - scrollSent < 500) {
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => { scrollSent = now(); emit('scroll', event.target) }, 500)
      return
    }
    scrollSent = at
    emit('scroll', event.target)
  }

  let lastURL = location.href
  const checkURL = cause => {
    if (location.href === lastURL) return
    const from = lastURL
    lastURL = location.href
    send({ type: 'navigation', at: now(), url: location.href, from, cause })
  }

  const opts = { capture: true, passive: true }
  document.addEventListener('click', onClick, opts)
  document.addEventListener('dblclick', onDblClick, opts)
  document.addEventListener('input', onInput, opts)
  document.addEventListener('change', onChange, opts)
  document.addEventListener('submit', onSubmit, opts)
  document.addEventListener('keydown', onKeyDown, opts)
  document.addEventListener('scroll', onScroll, opts)
  globalThis.addEventListener('popstate', () => checkURL('popstate'), true)
  globalThis.addEventListener('hashchange', () => checkURL('hashchange'), true)

  // A single-page app changes the URL without an event; the two listeners above
  // only cover history navigation. `pushState` is wrapped so a route change is
  // recorded as a navigation rather than silently disappearing.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    if (typeof original !== 'function') continue
    history[method] = function patched (...args) {
      const result = original.apply(this, args)
      checkURL(method)
      return result
    }
  }

  send({ type: 'recorder_ready', at: now(), url: location.href })
})()
