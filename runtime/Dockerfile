FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 make g++ util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts --no-audit --no-fund pnpm@11.28.5 \
 && install -d -o node -g node /dsh-home /workspace /backup /run/dsh-runtime

ENV DSH_HOME=/dsh-home \
    DSH_TELEMETRY_DISABLED=1 \
    npm_config_store_dir=/dsh-home/pnpm/store \
    npm_config_ignore_scripts=true

COPY --chmod=0755 dsh-runtime /usr/local/bin/dsh-runtime
# `--chmod` applies to implicitly-created parent directories too, not only to the
# file. `COPY --chmod=0644 x /usr/local/lib/dsh-runtime/x` therefore created
# /usr/local/lib/dsh-runtime at 0644, which stripped its execute bit; the
# container runs as `node`, could not enter the directory, and exited with
# "cannot locate compat.mjs and state.mjs". Creating the directory here, before
# any COPY, is what keeps COPY from setting its mode.
RUN install -d -m 0755 /usr/local/lib/dsh-runtime
COPY --chmod=0644 web.mjs /usr/local/lib/dsh-runtime/web.mjs
COPY --chmod=0644 compat.mjs /usr/local/lib/dsh-runtime/compat.mjs
COPY --chmod=0644 state.mjs /usr/local/lib/dsh-runtime/state.mjs
COPY browser-bundle /opt/workstation-browser
USER node
WORKDIR /workspace
ENTRYPOINT ["dsh-runtime"]
CMD ["serve"]
