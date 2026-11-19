// The tiny fixture emits DSH's pinned client bundle registration format directly.
window.__ModuleLoader__.load({
  id: 'dsh-m0-sidebar-probe',
  factory(require) {
    const { createElement: h } = require('react')
    return {
      inject: ['sidebarRightTabs', 'sidebarRight', 'slots'],
      apply(ctx) {
        const id = 'dsh-m0-sidebar-probe'
        const kind = 'm0-browser'
        const title = () => 'M0 Browser Desktop'
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id, kind, title, keepMounted: true, guide: { order: 10, title },
        }), 'M0 browser tab')
        const button = (text, onClick) => h('button', { type: 'button', onClick }, text)
        function Body({ useTabInfo }) {
          const { tab } = useTabInfo()
          return h('div', null,
            button('M0 Float', () => ctx.sidebarRight.float(tab.id)),
            button('M0 Guide', () => ctx.sidebarRight.openTab('guide')),
            button('M0 Hide', () => ctx.sidebarRight.hide(tab.id)),
            h('iframe', { src: '/browser/', title: 'M0 lifecycle probe', style: { width: '100%' } }))
        }
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: id }, Body,
        )), 'M0 browser body')
      },
    }
  },
})
