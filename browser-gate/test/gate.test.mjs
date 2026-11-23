import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CLOSED, InputGate, OPEN, RELEASING } from '../gate.mjs'

// The state machine on its own. The integration test in gate.test.mjs proves
// these states hold against a fake upstream that enforces the real ordering;
// this file pins each transition and the frames it produces.

test('starts closed, so a gate that has not been granted never forwards input', () => {
  const gate = new InputGate()
  assert.equal(gate.state, CLOSED)
  assert.deepEqual(gate.fromOperator('kd,97'), [])
  assert.deepEqual(gate.fromOperator('m,10,20,1,0'), [])
})

test('forwards non-input verbs while closed so the stream stays alive', () => {
  const gate = new InputGate()
  const settings = 'SETTINGS,{"displayId":"primary"}'
  assert.deepEqual(gate.fromOperator(settings), [settings])
  assert.deepEqual(gate.fromOperator('START_VIDEO'), ['START_VIDEO'])
  // Authority governs input, not the video control plane.
  assert.equal(gate.state, CLOSED)
})

test('a grant opens input and a revocation closes it', () => {
  const gate = new InputGate()
  assert.equal(gate.grant(), true)
  assert.equal(gate.state, OPEN)
  assert.deepEqual(gate.fromOperator('kd,97'), ['kd,97'])
  assert.equal(gate.revoke(), true)
  assert.equal(gate.state, CLOSED)
  assert.deepEqual(gate.fromOperator('kd,98'), [])
})

test('a grant during a release is refused, which is the interleaving M0 recorded', () => {
  const gate = new InputGate()
  gate.grant()
  gate.beginHandover()
  assert.equal(gate.state, RELEASING)
  assert.equal(gate.grant(), false, 'authority returned while the release was outstanding')
  assert.equal(gate.state, RELEASING)
  assert.deepEqual(gate.fromOperator('kd,97'), [], 'input reopened mid-release')
})

test('handover emits the two upstream release primitives in order and is idempotent', () => {
  const gate = new InputGate()
  gate.grant()
  gate.fromOperator('kd,97')
  gate.fromOperator('m,10,20,1,0,5')
  const frames = gate.beginHandover()
  assert.equal(frames[0], 'kr', 'reset_keyboard must come first')
  assert.match(frames[1], /^m2,0,0,0,0,\d+$/, 'a zero-delta relative pointer message releases the buttons')
  // Upstream discards an absolute pointer message older than the last applied
  // one, so the release must be the relative form to always apply.
  assert.deepEqual(gate.beginHandover(), [], 'a second handover emitted more frames')
})

test('the release does not depend on what the gate happened to observe', () => {
  const gate = new InputGate()
  gate.grant()
  // The gate saw no key and no button, but upstream may still hold input the
  // gate never forwarded -- a press delivered before the gate was in the path,
  // for instance. The release is unconditional for that reason.
  const frames = gate.beginHandover()
  assert.equal(frames.length, 2)
})

test('handover clears tracked state and stays closed until an explicit resume and grant', () => {
  const gate = new InputGate()
  gate.grant()
  gate.fromOperator('kd,97')
  gate.fromOperator('m,10,20,1,0,5')
  gate.beginHandover()
  gate.handoverComplete()
  assert.equal(gate.state, CLOSED)
  assert.deepEqual(gate.status().keys, [])
  assert.equal(gate.status().buttons, 0)
  // A resume alone is not a grant.
  gate.resume()
  assert.equal(gate.state, CLOSED)
  assert.deepEqual(gate.fromOperator('kd,97'), [])
  gate.grant()
  assert.deepEqual(gate.fromOperator('kd,97'), ['kd,97'])
})

test('status reports the forwarded state without claiming authority', () => {
  const gate = new InputGate()
  gate.grant()
  gate.fromOperator('kd,97')
  gate.fromOperator('m,10,20,1,0,7')
  const status = gate.status()
  assert.equal(status.state, OPEN)
  assert.deepEqual(status.keys, [97])
  assert.equal(status.buttons, 1)
  assert.equal(status.seq, 7)
})

test('every input verb is gated, so no verb is left as a bypass', () => {
  const gate = new InputGate()
  const verbs = ['kd', 'ku', 'kh', 'kr', 'm', 'm2', 'co', 'cmd', 'sf', 'sfe']
  for (const verb of verbs) {
    assert.deepEqual(gate.fromOperator(`${verb},1`), [], `${verb} bypassed the closed gate`)
  }
  gate.grant()
  for (const verb of verbs) {
    assert.deepEqual(gate.fromOperator(`${verb},1`), [`${verb},1`], `${verb} was not forwarded when open`)
  }
})

test('malformed and empty frames are dropped rather than forwarded blind', () => {
  const gate = new InputGate()
  gate.grant()
  assert.deepEqual(gate.fromOperator(''), [])
  assert.deepEqual(gate.fromOperator(undefined), [])
  assert.deepEqual(gate.fromOperator(null), [])
})

test('a non-integer pointer mask does not corrupt tracked button state', () => {
  const gate = new InputGate()
  gate.grant()
  gate.fromOperator('m,10,20,1,0')
  gate.fromOperator('m,10,20,not-a-mask,0')
  assert.equal(gate.status().buttons, 1)
})

test('a late grant after a handover does not reopen input without a resume', () => {
  const gate = new InputGate()
  gate.grant()
  gate.beginHandover()
  gate.handoverComplete()
  // The table is restored on the way back to HUMAN, so MK_ACCESS,1 can arrive
  // before the control plane has finished handing back.
  assert.equal(gate.grant(), false, 'a late grant reopened input on its own')
  assert.equal(gate.state, CLOSED)
  assert.deepEqual(gate.fromOperator('kd,97'), [])
  // The explicit resume is what reopens, and only once authority holds.
  assert.equal(gate.resume(), true)
  assert.equal(gate.state, OPEN)
})

test('a resume before the grant leaves input closed until the grant arrives', () => {
  const gate = new InputGate()
  gate.beginHandover()
  gate.handoverComplete()
  assert.equal(gate.resume(), false, 'resume claimed input without authority')
  assert.equal(gate.state, CLOSED)
  assert.equal(gate.grant(), true)
  assert.equal(gate.state, OPEN)
})
