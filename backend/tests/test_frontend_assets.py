"""Every local file the pages load must be served: one missing module stops the whole editor."""
import json
import re

from fastapi.testclient import TestClient

from app.config import REPO_ROOT
from app.main import app

_HTML_REF=re.compile(r'(?:src|href)="\./([^"/?#]+)"')
_MODULE_REF=re.compile(r"""from\s+['"]\./([^'"/]+)['"]""")

def local_assets():
    found,pending=set(),["index.html","entrenamiento.html","circuitos.html","torneos.html","editor.html","competicion.html"]
    while pending:
        name=pending.pop()
        if name in found:continue
        found.add(name)
        pattern=_HTML_REF if name.endswith(".html") else _MODULE_REF if name.endswith(".mjs") else None
        if pattern:pending.extend(pattern.findall((REPO_ROOT/name).read_text(encoding="utf-8")))
    return found

def test_every_local_asset_is_served():
    assets=local_assets()
    assert {"app-shell.mjs","telemetry.mjs","charts.mjs","sector-comparison.mjs"} <= assets
    client=TestClient(app)
    missing=[name for name in sorted(assets) if client.get("/"+name).status_code!=200]
    assert missing==[],"Añade a _PUBLIC_FILES: "+", ".join(missing)

def test_the_app_can_be_installed_and_receive_a_shared_route():
    client=TestClient(app)
    manifest=json.loads((REPO_ROOT/"manifest.json").read_text(encoding="utf-8"))
    for icon in manifest["icons"]:
        response=client.get("/"+icon["src"].removeprefix("./"))
        assert response.status_code==200 and response.headers["content-type"]=="image/png",icon["src"]
    assert {"192x192","512x512"} <= {i["sizes"] for i in manifest["icons"]}
    worker=client.get("/sw.js")
    assert worker.status_code==200 and "javascript" in worker.headers["content-type"]
    assert manifest["share_target"]["action"]=="./compartir" and manifest["share_target"]["params"]["files"][0]["name"]=="file"
    # Without the service worker the file cannot be kept: back to the training page, which says so.
    shared=client.post("/compartir",files={"file":("ruta.gpx",b"<gpx/>","application/gpx+xml")},follow_redirects=False)
    assert shared.status_code==303 and shared.headers["location"]=="./entrenamiento.html?compartido"
