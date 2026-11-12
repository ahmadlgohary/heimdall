"""Serving the built frontend from the API (FRONTEND_DIST)."""

import httpx
import pytest

from app.core.config import Settings
from app.main import create_app
from app.services.storage_service import MemoryStorage

INDEX = "<!doctype html><title>Heimdall</title><div id='root'></div>"
BUNDLE = "console.log('app');" * 200  # big enough to be gzipped


@pytest.fixture
def dist(tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text(INDEX)
    (tmp_path / "assets" / "index-abc123.js").write_text(BUNDLE)
    (tmp_path / "favicon.svg").write_text("<svg/>")
    (tmp_path / "mockServiceWorker.js").write_text("// dev only")
    (tmp_path.parent / "secret.txt").write_text("outside the build")
    return tmp_path


@pytest.fixture
async def web(dist):
    app = create_app(Settings(frontend_dist=str(dist)), storage=MemoryStorage())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest.mark.parametrize(
    "path", ["/", "/login", "/dashboard", "/events/2b1f8f4e-1d1a-4a51", "/settings/api-keys"]
)
async def test_app_routes_serve_index_html_uncached(web, path):
    res = await web.get(path)
    assert res.status_code == 200
    assert res.text == INDEX and res.headers["content-type"].startswith("text/html")
    assert res.headers["cache-control"] == "no-cache"
    assert res.headers["x-frame-options"] == "DENY"


async def test_hashed_assets_are_cached_forever_and_compressed(web):
    res = await web.get("/assets/index-abc123.js", headers={"Accept-Encoding": "gzip"})
    assert res.status_code == 200 and res.text == BUNDLE
    assert "javascript" in res.headers["content-type"]
    assert res.headers["cache-control"] == "public, max-age=31536000, immutable"
    assert res.headers["content-encoding"] == "gzip"


async def test_top_level_files_are_served(web):
    res = await web.get("/favicon.svg")
    assert res.status_code == 200 and res.text == "<svg/>" and res.headers["cache-control"] == "no-cache"


@pytest.mark.parametrize(
    "path",
    [
        "/assets/missing.js",  # never HTML where a script is expected
        "/robots.txt",  # file-looking paths that don't exist
        "/mockServiceWorker.js",  # dev-only, never served
        "/api/v1/nope",
        "/api",
        "/demo-receiver/anything",
        "/..%2fsecret.txt",
        "/assets/..%2f..%2fsecret.txt",
    ],
)
async def test_missing_files_and_api_paths_get_a_json_404(web, path):
    res = await web.get(path)
    assert res.status_code == 404, path
    assert res.headers["content-type"].startswith("application/json")
    assert "outside the build" not in res.text


async def test_api_semantics_are_unchanged(web):
    assert (await web.get("/health")).json() == {"status": "ok"}
    assert (await web.get("/api/v1/demo")).json()["enabled"] is False
    assert (await web.post("/api/v1/nope")).status_code == 404  # unknown API path: 404, not 405
    assert (await web.put("/api/v1/endpoints")).status_code == 405  # wrong method: still 405
    assert (await web.post("/dashboard")).status_code == 404  # pages are GET only
    docs = await web.get("/docs")
    assert docs.status_code == 200 and "swagger" in docs.text.lower()
    assert (await web.head("/dashboard")).status_code == 200


async def test_disabled_by_default():
    app = create_app(Settings(), storage=MemoryStorage())
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        res = await c.get("/dashboard")
        assert res.status_code == 404 and res.headers["content-type"].startswith("application/json")


def test_misconfigured_dist_fails_fast(tmp_path):
    with pytest.raises(RuntimeError, match=r"index\.html"):
        create_app(Settings(frontend_dist=str(tmp_path)), storage=MemoryStorage())
