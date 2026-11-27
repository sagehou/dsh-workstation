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
  const help = upgrade.querySelector('[data-upgrade-help]')
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
      const { message: next, status } = await reply.json()
      const key = JSON.stringify({ next, status })
      if (key === statusKey) return
      statusKey = key
      upgrade.hidden = false
      if (message.textContent !== next) message.textContent = next
      version.textContent = `${status.from} → ${status.to}`
      backup.hidden = !status.backup
      backup.textContent = status.backup ? `备份 ID ${status.backup}` : ''
      const reasons = status.blockers ?? []
      help.hidden = reasons.length > 0
      blockers.hidden = reasons.length === 0
      blockers.textContent = reasons.join('\n')
    } catch {
      // A transient network error leaves the last observed phase visible.
    }
  }
  const poll = async () => {
    if (await update() !== false) setTimeout(poll, 3000)
  }
  poll()
}
