"""Serve the built frontend (frontend/dist) from the API process.

One server for the UI and the API means the page can't load before the API is up,
the refresh-token cookie is same-origin, and no CORS setup is needed.

Enabled by FRONTEND_DIST (the production image sets it):
  /assets/*                       hashed build files, cached for a year
  /<file in dist> (favicon.svg)   served as files, revalidated on each load
  other GET/HEAD with no route    index.html, so client-side routes like /events/<id> work

The fallback hooks into "no route matched" (404) rather than adding a catch-all
route, so every API status code is unchanged: unknown /api/... paths still get the
API's JSON 404, and a wrong method on an API route still gets 405.
"""

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

from app.core.exceptions import error_body

# Never answered with the web app: these belong to the API or are files.
RESERVED_PREFIXES = ("/api/", "/assets/", "/demo-receiver/", "/docs/")
RESERVED_PATHS = {
    "/api",
    "/assets",
    "/demo-receiver",
    "/docs",
    "/openapi.json",
    "/health",
    "/ready",
    "/redoc",
}
# Development-only file from the mock API; never served.
EXCLUDED_FILES = {"mockServiceWorker.js"}

IMMUTABLE = "public, max-age=31536000, immutable"
REVALIDATE = "no-cache"


class HashedAssets(StaticFiles):
    """Build output under /assets has content hashes in its names, so it never changes."""

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        if response.status_code == 200:
            response.headers["Cache-Control"] = IMMUTABLE
        return response


def mount_frontend(app: FastAPI, dist: Path) -> None:
    dist = dist.resolve()
    index = dist / "index.html"
    if not index.is_file():
        raise RuntimeError(f"FRONTEND_DIST={dist} has no index.html; build the frontend first")

    if (dist / "assets").is_dir():
        app.mount("/assets", HashedAssets(directory=dist / "assets"), name="frontend-assets")

    # exact top-level names only, so no path traversal is possible
    top_level_files = {f"/{p.name}" for p in dist.iterdir() if p.is_file() and p.name not in EXCLUDED_FILES}

    async def not_found(request: Request, exc: StarletteHTTPException):
        path = request.url.path
        if request.method in ("GET", "HEAD") and not (
            path in RESERVED_PATHS or path.startswith(RESERVED_PREFIXES)
        ):
            if path in top_level_files:
                return FileResponse(dist / path.lstrip("/"), headers={"Cache-Control": REVALIDATE})
            if "." not in path.rsplit("/", 1)[-1]:  # a page, not a missing file like /robots.txt
                return FileResponse(index, media_type="text/html", headers={"Cache-Control": REVALIDATE})
        message = exc.detail if isinstance(exc.detail, str) else "Not found."
        return JSONResponse(error_body("NOT_FOUND", message), status_code=404, headers=exc.headers)

    app.add_exception_handler(404, not_found)
