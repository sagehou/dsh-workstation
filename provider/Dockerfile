FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /provider
COPY provider/package.json provider/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && install -d -m 0700 -o node -g node /state /run/workstation-cdp
COPY prototypes/m0/provider/server.mjs ./
COPY provider/cdp.mjs ./
USER node
CMD ["node", "cdp.mjs"]
