// The input-authority state machine for the browser gate (ADR-0005).
//
// Why this exists: the pinned Selkies evaluates input authority against the
// live token table on every input frame (websockets_mode.py:6235), and
// provision_tokens() installs that table *before* it pushes MK_ACCESS,0
// (:8071, :8356). A frame sent after the revocation is therefore dropped --
// including the release frame for a button the operator was already holding.
// That is the M0 failure ("a mouse button held before grant was not released
// by the live Selkies token update") stated from the server's side.
//
// The only window in which a release can land is *before* the table changes.
// So the gate never reacts to MK_ACCESS,0 by trying to release; it releases on
// command from the control plane, which calls it first and flips the table
// second.
//
// Release uses upstream's own two primitives rather than a replayed keystroke
// log, so it also covers state the gate never observed:
//   kr                  -> reset_keyboard(): releases every held key/modifier
//   m2,0,0,0,0,<seq>    -> send_x11_mouse(0,0,0,0,relative=True): the exact
//                          call release_mouse_buttons() makes
//
// Two independent facts decide whether input is forwarded:
//
//   authority  what Selkies last announced (MK_ACCESS,1 / 0)
//   permitted  whether the control plane has said the operator may drive
//
// Input flows only when both hold and no handover is in progress. Keeping them
// separate is what stops a late MK_ACCESS,1 -- the table being restored on the
// way back to HUMAN -- from reopening input before the control plane has
// finished handing back.
//
// States:
//   CLOSED     operator input is refused
//   OPEN       operator input is forwarded
//   RELEASING  a handover is in progress; the release has been produced but
//              not yet proven, and input is refused throughout

export const CLOSED = 'CLOSED'
export const OPEN = 'OPEN'
export const RELEASING = 'RELEASING'

// Input verbs gated by authority. Selkies' SECURE_INPUT_PREFIXES, minus the
// gamepad and clipboard families this deployment disables in Compose.
const INPUT_VERBS = new Set(['kd', 'ku', 'kh', 'kr', 'm', 'm2', 'co', 'cmd', 'sf', 'sfe'])

export class InputGate {
  constructor () {
    this.state = CLOSED
    // Selkies last said this connection may drive input.
    this.authority = false
    // The control plane has not withdrawn the operator's permission. True at
    // startup: the first MK_ACCESS,1 of a fresh session should simply work.
    this.permitted = true
    // Selkies has granted this connection authority at some point. Distinct
    // from `authority`: a connection that was never granted cannot be holding
    // anything the gate needs to release, whereas one that lost authority
    // *outside* a handover is holding state the gate can no longer release.
    this.everGranted = false
    // A handover on this connection has already been proven. Makes a retried
    // /handover idempotent instead of re-sending frames upstream would drop.
    this.released = false
    this.seq = 0
    // Not used to synthesise the release -- upstream's primitives are. Kept so
    // /status can report what the gate last forwarded, which is what the
    // handover assertions and the readiness probe read.
    this.keys = new Set()
    this.buttons = 0
  }

  // Whether the operator may send input right now.
  get forwarding () {
    return this.state === OPEN
  }

  // Selkies granted authority. Refused while a release is outstanding: reopening
  // there is the interleaving M0 recorded.
  grant () {
    if (this.state === RELEASING) return false
    this.authority = true
    this.everGranted = true
    // A fresh grant begins a new authority epoch, so a release proven in an
    // earlier one must not make this one look already released. Authority
    // returning mid-handover is refused above, so this cannot clobber an
    // outstanding release.
    this.released = false
    this.state = this.permitted ? OPEN : CLOSED
    return this.state === OPEN
  }

  // Selkies revoked authority. Closes the path immediately. Releasing is not
  // possible from here -- the frames would be dropped -- which is exactly why
  // the release is ordered before the revocation.
  revoke () {
    const wasForwarding = this.state === OPEN
    this.authority = false
    this.state = CLOSED
    this.keys.clear()
    this.buttons = 0
    return wasForwarding
  }

  // Whether a release can still be proven on this connection. Once authority is
  // gone, the very frames that would release are what upstream drops, so a
  // handover must be refused rather than reported as a release.
  get releasable () {
    return this.authority && !this.released
  }

  // Begin a handover. Returns the frames to send upstream, in order, while the
  // socket still holds authority. Idempotent.
  beginHandover () {
    if (this.state === RELEASING) return []
    this.state = RELEASING
    // Permission is withdrawn now: a grant that lands during the release must
    // not reopen input, and the handback has to be explicit.
    this.permitted = false
    this.seq += 1
    const frames = [
      'kr',
      // m2 is the relative form, which upstream never discards as stale
      // (websockets_mode.py:9298), so the button release always applies.
      `m2,0,0,0,0,${this.seq}`
    ]
    this.keys.clear()
    this.buttons = 0
    return frames
  }

  // The release was sent and proven. Input stays closed until an explicit
  // resume, and a fresh grant.
  handoverComplete () {
    this.state = CLOSED
    this.authority = false
    this.released = true
  }

  // The release could not be proven and the socket is being closed instead.
  // Distinct from handoverComplete(): that records a proof, this records the
  // absence of one, so /handover keeps refusing until a later handover succeeds.
  abandon () {
    this.state = CLOSED
    this.authority = false
    this.released = false
  }

  // The control plane says the operator may drive again. Input still needs
  // Selkies to grant authority; if it already has, this opens immediately.
  resume () {
    this.permitted = true
    this.state = this.authority ? OPEN : CLOSED
    return this.state === OPEN
  }

  // Handle one operator->upstream frame. Returns the frames to forward, which
  // is nothing unless the operator currently holds authority.
  fromOperator (message) {
    if (typeof message !== 'string' || message.length === 0) return []
    const verb = message.split(',', 1)[0]
    if (!INPUT_VERBS.has(verb)) {
      // Non-input verbs (SETTINGS, ACKs, START_VIDEO) keep the stream alive for
      // both roles; authority governs input only.
      return [message]
    }
    if (this.state !== OPEN) return []
    this.track(message)
    return [message]
  }

  // Remember forwarded press state for /status.
  track (message) {
    const t = message.split(',')
    switch (t[0]) {
      case 'kd': {
        const code = Number(t[1])
        if (Number.isInteger(code)) this.keys.add(code)
        break
      }
      case 'ku': {
        const code = Number(t[1])
        if (Number.isInteger(code)) this.keys.delete(code)
        break
      }
      case 'kr':
        this.keys.clear()
        break
      case 'm':
      case 'm2': {
        const mask = Number(t[3])
        if (Number.isInteger(mask)) this.buttons = mask & 0x3f
        const seq = Number(t[5])
        if (Number.isInteger(seq)) this.seq = Math.max(this.seq, seq)
        break
      }
    }
  }

  // Read by the control API and the health check.
  status () {
    return {
      state: this.state,
      authority: this.authority,
      permitted: this.permitted,
      everGranted: this.everGranted,
      released: this.released,
      keys: [...this.keys],
      buttons: this.buttons,
      seq: this.seq,
    }
  }
}
