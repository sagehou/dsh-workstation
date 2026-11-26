for (const button of document.querySelectorAll('[data-reveal]')) {
  const input = document.getElementById(button.getAttribute('aria-controls'))
  button.hidden = false
  button.addEventListener('click', () => {
    const reveal = input.type === 'password'
    input.type = reveal ? 'text' : 'password'
    button.setAttribute('aria-pressed', String(reveal))
  })
}
