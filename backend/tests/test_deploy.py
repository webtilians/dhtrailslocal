"""deploy/vps: the files the Linux server reads must stay consistent and usable from a Windows checkout."""
import re

from app.config import REPO_ROOT

VPS = REPO_ROOT / "deploy" / "vps"

def test_server_files_use_unix_line_endings():
    for path in [VPS / "setup.sh", *sorted((VPS / "bin").iterdir())]:
        data = path.read_bytes()
        assert b"\r" not in data, path
        assert data.startswith(b"#!/usr/bin/env bash\n"), path
    for path in [*sorted((VPS / "systemd").iterdir()), VPS / "dhtrails.caddy"]:
        assert b"\r" not in path.read_bytes(), path

def test_service_caddy_and_lain_ports_do_not_clash():
    unit = (VPS / "systemd" / "dhtrails.service").read_text(encoding="utf-8")
    command = re.search(r"^ExecStart=(.+)$", unit, re.M).group(1).split()
    assert command[1] == "app.main:app" and command[command.index("--port") + 1] == "8100"
    assert command[command.index("--host") + 1] == "127.0.0.1"
    assert "ExecStartPre=/opt/dhtrails-venv/bin/alembic upgrade head" in unit
    assert "ReadWritePaths=/var/lib/dhtrails" in unit and "MemoryMax=" in unit
    assert "reverse_proxy 127.0.0.1:8100" in (VPS / "dhtrails.caddy").read_text(encoding="utf-8")

def test_every_setting_written_by_setup_is_read_by_the_app():
    setup = (VPS / "setup.sh").read_text(encoding="utf-8")
    written = set(re.findall(r"^([A-Z_]+)=", setup.split("<<EOF", 1)[1].split("\nEOF", 1)[0], re.M))
    config = (REPO_ROOT / "backend" / "app" / "config.py").read_text(encoding="utf-8")
    read = set(re.findall(r'os\.getenv\("([A-Z_]+)"', config))
    assert written - {"PYTHONDONTWRITEBYTECODE"} <= read
    assert {"SECRET_KEY", "ORGANIZER_EMAILS", "INVITE_CODE", "DATABASE_URL"} <= written
