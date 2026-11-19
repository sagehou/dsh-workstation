FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /m0
RUN npm install --ignore-scripts --no-audit --no-fund --save-exact playwright@1.61.1 @modelcontextprotocol/sdk@1.31.0 zod@4.4.3 \
 && install -d -o node -g node /state
USER node
