// DSH's external Web client module registry.
window.__ModuleLoader__.load({
  id: 'dsh-workstation-browser',
  factory(require) {
    const { createElement: h } = require('react')
    const id = 'workstation-browser'
    const title = () => '浏览器'
    const entry = '/_auth/browser'

    function BrowserPane() {
      return h('div', { style: { display: 'flex', flexDirection: 'column', blockSize: '100%', minBlockSize: 0 } },
        h('div', { style: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: '1rem', padding: '0.55rem 0.8rem' } },
          h('a', { href: '/mgmt/browser', target: '_blank', rel: 'noopener' }, '浏览器控制'),
          h('a', { href: entry, target: '_blank', rel: 'noopener' }, '在新标签页打开')),
        h('iframe', {
          src: entry,
          title: '共享 Chromium 桌面',
          allow: 'fullscreen',
          style: { flex: '1 1 0', inlineSize: '100%', minBlockSize: 0, border: 0, display: 'block' },
        }))
    }

    return {
      name: 'workstation-browser-client',
      inject: ['sidebarRightTabs', 'slots'],
      async apply(ctx) {
        // Existing Profiles can keep the Bundle when switching to the core deployment.
        const capability = await fetch('/_auth/browser-available', { signal: AbortSignal.timeout(4000) }).catch(() => null)
        if (capability?.status !== 204) return
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind: id, title, keepMounted: true, guide: [{ id, title, order: 50 }],
        }), 'Workstation browser tab')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: id }, BrowserPane,
        )), 'Workstation browser pane')
      },
    }
  },
})
