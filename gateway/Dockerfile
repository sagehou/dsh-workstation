FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS source
WORKDIR /src
ENV GOTOOLCHAIN=local
# Empty by default: proxy.golang.org is only unreachable in mainland China, where a
# build passes --build-arg GOPROXY=https://goproxy.cn,direct. Baking a mirror in
# unconditionally made CI builds resolve modules through a distant host.
ARG GOPROXY=
ENV GOPROXY=${GOPROXY}
COPY gateway/ .

FROM source AS build
RUN CGO_ENABLED=1 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/gateway .

FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS node

FROM node AS browser-workers
WORKDIR /opt/workstation/provider
COPY provider/package.json provider/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY provider/cdp.mjs prototypes/m0/provider/server.mjs prototypes/m0/provider/recorder.js ./
WORKDIR /opt/workstation/gate
COPY browser-gate/package.json browser-gate/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY browser-gate/gate.mjs browser-gate/server.mjs ./

FROM node
# curl is not used by the service: the healthcheck uses Go's own HTTP client.
# It is installed so an operator can diagnose from inside the container, which is
# otherwise impossible on a slim image with no HTTP client at all.
# Empty by default: Debian's own mirror is correct everywhere except mainland
# China, where it is unreliable. A build there passes
# --build-arg DEBIAN_MIRROR=mirrors.tuna.tsinghua.edu.cn. Baking the
# substitution in unconditionally made CI slower, not faster, because the
# mirror is far from the runner.
ARG DEBIAN_MIRROR=
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi; \
    apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 0700 -o 1000 -g 1000 /data /state
COPY --from=build /out/gateway /usr/local/bin/workstation-gateway
COPY --from=browser-workers /opt/workstation /opt/workstation
COPY --chmod=0755 gateway/start.sh /usr/local/bin/workstation-start
USER 1000:1000
ENTRYPOINT ["workstation-start"]
CMD ["serve"]
