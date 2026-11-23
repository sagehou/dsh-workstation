FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /gate
COPY browser-gate/package.json browser-gate/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY browser-gate/gate.mjs browser-gate/server.mjs ./
USER node
# The gate is the only thing that may talk to the Selkies data socket for
# input, so it must not be reachable from any other service.
EXPOSE 8082
CMD ["node", "server.mjs"]
