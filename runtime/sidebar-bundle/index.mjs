// Host half of the Workstation sidebar Bundle.
//
// The tab itself is a client module (./client.js); this file exists so the
// package has a Host face the Loader can activate, which is what makes the
// `dsh.client` declaration in package.json reach the boot graph. Without it the
// client export is never scanned and the tab never appears.
//
// Deliberately does nothing else: the sidebar tab renders a same-origin iframe of
// /browser/, and everything behind that URL (ForwardAuth, the input gate, the
// lease) is enforced by the Gateway and the Provider, not here. Putting policy in
// this file would create a second place to get it wrong.

export const name = 'workstation-sidebar'

export function apply() {
  // No Host-side behaviour. The disposer is owned by the client module.
}
