# M0 Web Profile adapter

This opt-in slice uses the pinned DSH `0.2.2-rc.1` [Agent-scoped context](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/docs/subsystems/core.md#L74) and [official MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db/packages/mcp/mcp-client/README.md). Each live Web session consumes its own ticket. The Provider creates a tab in the shared profile on the first manual grant. It dispatches only to that tab, checks the lease generation, and holds one lease for the entire browser. If that tab closes or its Chromium process is replaced, use a new live session activation and a new grant. The Provider leaves tabs open when sessions retire.

This path has not been run. It is limited to the fixture marker tool, with DSH Web on container loopback. No deployment routing or Sidebar is added. Finish any keyboard or mouse input before granting control; the existing [held-input failure](../../../../docs/roadmap/M0-provider-evidence.md#observed-result) still applies.

For a future bring-up on a disposable **GitHub-hosted Actions** runner, use the Compose files, fresh volumes, and secret setup in [provider/run.sh](../run.sh) through `compose build`. Replace the install step with:

```sh
compose run --rm --no-deps -T install-dsh bash -euc '
  test ! -e "$DSH_HOME/profiles/web"
  bash /runtime/runtime.sh install 0.2.2-rc.1
  "$DSH_HOME/runtime/versions/0.2.2-rc.1/node_modules/.bin/dsh" plugin --profile web add \
    --save-exact --ignore-scripts --ignore-workspace-root-check file:/m0/provider/web/bundle
'
compose up --no-build -d fixture witness chromium cdp-relay edge provider dsh viewer
```

When Chromium is ready, recover the Provider and launch Web using the existing loopback model fixture:

```sh
control() { compose exec -T viewer node /m0/provider/web/control.mjs "$@"; }
control recover
control tickets 2 | compose exec -T dsh node /m0/provider/agent.mjs --web
```

Keep that launcher running. Its output names the private launch URL file for a trusted driver in the `dsh` container and reports session-to-peer IDs. Read the URL privately for the normal Web bootstrap; never echo its contents. Tickets expire after five minutes if unused, and are passed through a pipe, outside profile files and logs.

Open a Web conversation and send a message to activate it. When ready to hand over, use `control grant PEER_ID` with the peer that the launcher printed for that session. The controller prints the generation. Send `m0:example:GENERATION:once` in that conversation to exercise the fixture marker, then use `control takeover` to return control to the human. Tear down the disposable stack with the existing cleanup in `provider/run.sh`.
