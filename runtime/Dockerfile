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
# `--chmod` applies to the destination directory as well as the files when the
# destination ends in `/`, so a 0644 here made /usr/local/lib/dsh-runtime
# unenterable and the runtime could not find its own modules. Naming each file
# and its full path applies the mode to the file only; COPY creates the parent
# directory with the default 0755.
COPY --chmod=0644 web.mjs /usr/local/lib/dsh-runtime/web.mjs
COPY --chmod=0644 compat.mjs /usr/local/lib/dsh-runtime/compat.mjs
COPY --chmod=0644 state.mjs /usr/local/lib/dsh-runtime/state.mjs
COPY browser-bundle /opt/workstation-browser
USER node
WORKDIR /workspace
ENTRYPOINT ["dsh-runtime"]
CMD ["serve"]
