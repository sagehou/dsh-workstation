FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node

FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 AS probe
WORKDIR /m0
RUN npm install --ignore-scripts --no-audit --no-fund --save-exact playwright@1.61.1
COPY probe.mjs exclusive.mjs /m0/
USER pwuser

FROM probe AS sidebar
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN npm install -g --ignore-scripts --no-audit --no-fund pnpm@11.28.5
COPY sidebar /m0/sidebar
USER pwuser
