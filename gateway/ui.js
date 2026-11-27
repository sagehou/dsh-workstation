for (const button of document.querySelectorAll('[data-reveal]')) {
  const input = document.getElementById(button.getAttribute('aria-controls'))
  button.hidden = false
  button.addEventListener('click', () => {
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.setAttribute('aria-pressed', String(reveal))
  })
}

const upgrade = document.querySelector('[data-upgrade]')
if (upgrade) {
  const message = upgrade.querySelector('[data-upgrade-message]')
  const version = upgrade.querySelector('[data-upgrade-version]')
  const backup = upgrade.querySelector('[data-upgrade-backup]')
  const blockers = upgrade.querySelector('[data-upgrade-blockers]')
  const details = upgrade.querySelector('[data-upgrade-details]')
  const progress = upgrade.querySelector('[data-upgrade-progress]')
  const active = document.querySelector('[data-active-version]')
  const versions = document.querySelector('[data-installed-versions]')
  const opener = document.querySelector('[data-upgrade-open]')
  const dialog = document.querySelector('[data-upgrade-dialog]')
  if (typeof dialog?.showModal === 'function') {
    opener.addEventListener('click', event => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || upgrade.dataset.result === 'running') return
      event.preventDefault()
      dialog.showModal()
    })
    dialog.querySelector('[data-dialog-cancel]').addEventListener('click', () => dialog.close())
  }
  const updateAction = () => {
    const running = upgrade.dataset.result === 'running'
    opener.textContent = running ? '查看升级进度' : '升级 DSH'
    opener.href = running ? '#upgrade-message' : '/mgmt/upgrade'
  }
  updateAction()
  let statusKey
  const update = async () => {
    try {
      if (document.hidden) return
      const reply = await fetch('/mgmt/upgrade-status', { signal: AbortSignal.timeout(5000) })
      if (reply.status === 401) {
        if (!upgrade.hidden) message.textContent = '会话已过期，请刷新页面。'
        return false
      }
      if (!reply.ok) return
      const { message: next, status, progress: step, runtime } = await reply.json()
      const key = JSON.stringify({ next, status, runtime })
      if (key === statusKey) return
      statusKey = key
      upgrade.hidden = false
      upgrade.dataset.result = status.result
      updateAction()
      progress.hidden = status.result !== 'running'
      progress.value = step
      if (message.textContent !== next) message.textContent = next
      version.textContent = `${status.from} → ${status.to}`
      backup.hidden = !status.backup
      backup.textContent = status.backup ? `备份 ID ${status.backup}` : ''
      const reasons = status.blockers ?? []
      details.hidden = reasons.length === 0
      blockers.textContent = reasons.join('\n')
      if (runtime.active) active.textContent = runtime.active
      if (runtime.installed.length) {
        const list = document.createElement('ul')
        list.className = 'data-list version-list'
        list.setAttribute('role', 'list')
        for (const installed of runtime.installed) {
          const row = document.createElement('li')
          const label = document.createElement('code')
          label.textContent = installed
          row.append(label)
          if (installed === runtime.active || installed === runtime.previous) {
            const state = document.createElement('span')
            const current = installed === runtime.active
            state.className = current ? 'status success' : 'status muted'
            state.textContent = current ? '使用中' : '上一个版本'
            row.append(state)
          }
          list.append(row)
        }
        versions.replaceChildren(list)
      }
    } catch {
      // A transient network error leaves the last observed phase visible.
    }
  }
  const poll = async () => {
    if (await update() !== false) setTimeout(poll, 3000)
  }
  poll()
}

for (const form of document.querySelectorAll('[data-upgrade-form]')) {
  const submit = form.querySelector('[type=submit]')
  form.addEventListener('submit', () => { submit.disabled = true })
  window.addEventListener('pageshow', () => { submit.disabled = false })
}
