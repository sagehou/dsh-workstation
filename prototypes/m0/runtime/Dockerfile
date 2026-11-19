FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 make g++ util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --ignore-scripts --no-audit --no-fund pnpm@11.28.5 \
 && install -d -o node -g node /dsh-home /workspace /backup
USER node
WORKDIR /workspace
