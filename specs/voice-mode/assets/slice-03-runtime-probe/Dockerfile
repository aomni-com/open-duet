# syntax=docker/dockerfile:1
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_DEV=1

WORKDIR /probe
COPY pyproject.toml uv.lock ./
COPY src ./src
COPY fixtures/four-second-spoken.ogg ./fixtures/four-second-spoken.ogg
RUN uv sync --locked --no-dev

RUN adduser --disabled-password --gecos "" --home /probe --uid 10001 probe \
    && chown -R probe:probe /probe
USER probe

CMD ["uv", "run", "python", "-m", "voice_probe.launch", "start"]
