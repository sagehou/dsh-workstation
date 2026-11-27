FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# Debian's default mirror and the public npm registry are both unreliable from
# mainland China, where this image is built and deployed. The substitution is
# inside the layer, so it does not depend on host configuration.
# Empty by default: Debian's own mirror is correct everywhere except mainland
# China, where it is unreliable. A build there passes
# --build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn. Baking the
# substitution in unconditionally made CI slower, not faster, because the
# mirror is far from the runner.
ARG DEBIAN_MIRROR=
# Same reasoning as DEBIAN_MIRROR: the public registry is the right default, and a
# build in mainland China passes --build-arg NPM_REGISTRY=https://registry.npmmirror.com.
ARG NPM_REGISTRY=
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 make g++ util-linux xdg-user-dirs=0.18-1 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global ${NPM_REGISTRY:+--registry=$NPM_REGISTRY} --ignore-scripts --no-audit --no-fund pnpm@11.28.5 \
 && install -d -o node -g node /dsh-home/.agents /workspace /backup /run/dsh-runtime /home/node/.config \
 && chown node:node /dsh-home \
 && printf '%s\n' 'XDG_DOCUMENTS_DIR="/workspace"' > /home/node/.config/user-dirs.dirs \
 && ln -s /dsh-home/.agents /home/node/.agents

ENV DSH_HOME=/dsh-home \
    DSH_AGENTS_HOME=/dsh-home/.agents \
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
COPY --chmod=0644 maintenance.mjs /usr/local/lib/dsh-runtime/maintenance.mjs
COPY --chmod=0644 managed-web.mjs /usr/local/lib/dsh-runtime/managed-web.mjs
COPY --chmod=0644 compat.mjs /usr/local/lib/dsh-runtime/compat.mjs
COPY --chmod=0644 state.mjs /usr/local/lib/dsh-runtime/state.mjs
COPY browser-bundle /opt/workstation-browser
USER node
WORKDIR /workspace
ENTRYPOINT ["dsh-runtime"]
CMD ["serve"]
