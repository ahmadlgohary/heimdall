# syntax=docker/dockerfile:1
# One image runs every backend process; pick one with the command:
#   api        uvicorn app.main:app --host 0.0.0.0 --port 8000   (default)
#   worker     python -m app.workers.delivery_worker
#   publisher  python -m app.workers.outbox_worker
#   migrate    alembic upgrade head
# Build with --build-arg INSTALL_DEV=true to include pytest/ruff (docker compose dev does).

FROM python:3.14-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
# set INSTALL_DEV=true for an image that can run the test suite
ARG INSTALL_DEV=false
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked --no-install-project $([ "$INSTALL_DEV" = "true" ] || echo --no-dev)
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --locked $([ "$INSTALL_DEV" = "true" ] || echo --no-dev)

FROM python:3.14-slim AS runtime
# /data/storage holds payloads when STORAGE_BACKEND=local (shared volume in docker compose)
RUN useradd --create-home --uid 10001 app && mkdir -p /data/storage && chown app:app /data/storage
WORKDIR /app
COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    LOCAL_STORAGE_PATH=/data/storage
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/health').status != 200)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
