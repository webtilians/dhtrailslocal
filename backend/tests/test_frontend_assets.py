"""Every local file the pages load must be served: one missing module stops the whole editor."""
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
        text=(REPO_ROOT/name).read_text(encoding="utf-8")
        pattern=_HTML_REF if name.endswith(".html") else _MODULE_REF if name.endswith(".mjs") else None
        if pattern:pending.extend(pattern.findall(text))
    return found

def test_every_local_asset_is_served():
    assets=local_assets()
    assert {"app-shell.mjs","telemetry.mjs","charts.mjs","sector-comparison.mjs"} <= assets
    client=TestClient(app)
    missing=[name for name in sorted(assets) if client.get("/"+name).status_code!=200]
    assert missing==[],"Añade a _PUBLIC_FILES: "+", ".join(missing)
