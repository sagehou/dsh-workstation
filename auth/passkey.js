const pk = globalThis.PublicKeyCredential
const csrf = document.querySelector('meta[name=csrf-token]')?.content
const status = document.getElementById('passkey-status')

const bytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
const base64url = value => btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
function binaryOptions(options, method) {
  // Older browsers can still use native WebAuthn with buffer-valued fields.
  const parse = method === 'register' ? pk.parseCreationOptionsFromJSON : pk.parseRequestOptionsFromJSON
  if (parse) return parse.call(pk, options)
  options.challenge = bytes(options.challenge)
  if (options.user) options.user.id = bytes(options.user.id)
  for (const field of ['allowCredentials', 'excludeCredentials']) {
    for (const descriptor of options[field] ?? []) descriptor.id = bytes(descriptor.id)
  }
  return options
}
function serialize(credential, method) {
  if (credential.toJSON) return credential.toJSON()
  const source = credential.response
  const response = { clientDataJSON: base64url(source.clientDataJSON) }
  for (const field of method === 'register' ? ['attestationObject'] : ['authenticatorData', 'signature', 'userHandle']) {
    if (source[field]) response[field] = base64url(source[field])
  }
  if (source.getTransports) response.transports = source.getTransports()
  return { id: credential.id, rawId: base64url(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment, response, clientExtensionResults: credential.getClientExtensionResults() }
}
async function post(path, body = {}, extra = {}) {
  const response = await fetch(path, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...extra },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw Error('Passkey request failed')
  return response.json()
}
for (const button of document.querySelectorAll('[data-passkey]')) {
  if (!globalThis.isSecureContext || !pk || !navigator.credentials) continue
  button.hidden = false
  button.addEventListener('click', async () => {
    const method = button.dataset.passkey
    const register = method === 'register'
    button.disabled = true
    status.hidden = true
    try {
      const base = '/_auth/passkey/' + method
      const start = await post(base + '/begin')
      const publicKey = binaryOptions((register ? start.options : start).publicKey, method)
      const credential = await navigator.credentials[register ? 'create' : 'get']({ publicKey })
      if (!credential) return
      const result = await post(base + '/finish?next=' + encodeURIComponent(button.dataset.next ?? '/'),
        serialize(credential, method), register ? { 'X-WebAuthn-Challenge': start.challenge } : {})
      location.assign(result.next)
    } catch (err) {
      if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
        status.hidden = false
        status.textContent = register ? '未能添加 Passkey。' : 'Passkey 登录失败，请重试或使用密码。'
      }
    } finally {
      button.disabled = false
    }
  })
}
