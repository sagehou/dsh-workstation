FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS source
WORKDIR /src
ENV GOTOOLCHAIN=local
# Empty by default: proxy.golang.org is only unreachable in mainland China, where a
# build passes --build-arg GOPROXY=https://goproxy.cn,direct. Baking a mirror in
# unconditionally made CI builds resolve modules through a distant host.
ARG GOPROXY=
ENV GOPROXY=${GOPROXY}
COPY . .

FROM source AS build
RUN CGO_ENABLED=1 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/auth .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
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
 && install -d -m 0700 -o 1000 -g 1000 /data
COPY --from=build /out/auth /usr/local/bin/workstation-auth
USER 1000:1000
ENTRYPOINT ["workstation-auth"]
CMD ["serve"]
