FROM oven/bun:1.3.14 AS bun

FROM node:24.14.0-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && test "$(bun --version)" = "1.3.14" \
    && test "$(node --version)" = "v24.14.0" \
    && test "$(npm --version)" = "11.9.0"

WORKDIR /work
