FROM golang:1.27.3-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS source
WORKDIR /src
ENV GOTOOLCHAIN=local
COPY . .

FROM source AS build
RUN CGO_ENABLED=1 go build -mod=mod -trimpath -ldflags="-s -w" -o /out/auth .

FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
RUN install -d -m 0700 -o 1000 -g 1000 /data
COPY --from=build /out/auth /usr/local/bin/workstation-auth
USER 1000:1000
ENTRYPOINT ["workstation-auth"]
CMD ["serve"]
