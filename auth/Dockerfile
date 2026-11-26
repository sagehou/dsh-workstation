FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS source
WORKDIR /src
ENV GOTOOLCHAIN=local
# proxy.golang.org is unreachable from mainland China, where this image is built.
# Overridable so a build in another region can use the default.
ARG GOPROXY=https://goproxy.cn,https://mirrors.aliyun.com/goproxy/,direct
ENV GOPROXY=${GOPROXY}
COPY . .

FROM source AS build
RUN CGO_ENABLED=1 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/auth .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
# curl is not used by the service: the healthcheck uses Go's own HTTP client.
# It is installed so an operator can diagnose from inside the container, which is
# otherwise impossible on a slim image with no HTTP client at all.
RUN sed -i "s|deb.debian.org|mirrors.tuna.tsinghua.edu.cn|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -m 0700 -o 1000 -g 1000 /data
COPY --from=build /out/auth /usr/local/bin/workstation-auth
USER 1000:1000
ENTRYPOINT ["workstation-auth"]
CMD ["serve"]
