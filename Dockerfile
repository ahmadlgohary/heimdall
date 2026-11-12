# syntax=docker/dockerfile:1
# Production image: the API serves the built web app from the same origin.
# Build from the repository root:   docker build -t heimdall .
# The same image runs every backend process; pick one with the command:
#   (default)   uvicorn: API + web app on :8000
#   worker      python -m app.workers.delivery_worker
#   publisher   python -m app.workers.outbox_worker
#   migrate     alembic upgrade head

# ---- 1. web app ----
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/ ./
# same origin: the API serves the app, so API calls go to /api/v1
ENV VITE_API_URL=""
RUN npm run build && rm -f dist/mockServiceWorker.js

# ---- 2. backend dependencies ----
FROM python:3.14-slim AS backend
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /uvx /bin/
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=0
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-install-project --no-dev
COPY backend/ ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --locked --no-dev

# ---- 3. runtime ----
FROM python:3.14-slim AS runtime
RUN useradd --create-home --uid 10001 app && mkdir -p /data/storage && chown app:app /data/storage
WORKDIR /app
COPY --from=backend --chown=app:app /app /app
COPY --from=web --chown=app:app /web/dist /app/web
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    FRONTEND_DIST=/app/web \
    LOCAL_STORAGE_PATH=/data/storage
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD python -c "import urllib.request,sys; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/health').status != 200)" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
