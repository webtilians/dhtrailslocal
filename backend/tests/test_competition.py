"""Monthly competition against PostgreSQL: publish, server timing, review and public standings."""
import math
import time
import uuid
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

def fixes(t0_ms, step_ms, lat_shift=0.0):
    return [(36.74 - i * 0.000061 + lat_shift, -4.45 + math.sin(i / 11) * 0.000094, 430 - i * 1.3, t0_ms + i * step_ms)
            for i in range(100)]

def gpx(t0_ms, step_ms, lat_shift=0.0):
    points = "".join(
        f'<trkpt lat="{lat}" lon="{lon}"><ele>{ele}</ele><time>'
        f'{datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]}Z</time></trkpt>'
        for lat, lon, ele, t in fixes(t0_ms, step_ms, lat_shift))
    return f'<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>{points}</trkseg></trk></gpx>'.encode()

def recent(minutes):
    return (time.time() - minutes * 60) * 1000

def account(client, name=None, email=None):
    email = email or f"rider-{uuid.uuid4().hex}@example.com"
    r = client.post("/api/auth/register", json={"email": email, "password": "very-long-testing-password"})
    assert r.status_code == 201, r.text
    headers = {"Authorization": "Bearer " + r.json()["access_token"]}
    if name:
        assert client.put("/api/me/profile", headers=headers, json={"display_name": name}).status_code == 200
    return headers

def submit(client, headers, circuit_id, data, name="bajada.gpx"):
    return client.post("/api/competition/entries", headers=headers, data={"circuit_id": circuit_id},
                       files={"file": (name, data, "application/gpx+xml")})

@pytest.fixture
def organizer(monkeypatch):
    email = f"org-{uuid.uuid4().hex}@example.com"
    monkeypatch.setattr(config, "ORGANIZER_EMAILS", {email})
    return email

def published(client, org):
    ref = fixes(0, 0)[10:88]
    payload = {"name": "Santa Cruz DH", "points": [[round(lat, 7), round(lon, 7), ele] for lat, lon, ele, _ in ref],
               "sectors": [{"index": 18, "name": "Curvas"}, {"index": 52, "name": "Rock garden"}],
               "weakZones": [{"from": 31, "to": 40, "name": "Sombra GPS"}], "gateRadius": 18}
    created = client.post("/api/circuits", headers=org, json=payload)
    assert created.status_code == 201, created.text
    cid = created.json()["id"]
    assert client.post(f"/api/circuits/{cid}/publish", headers=org).status_code == 200
    return cid, payload

def test_full_month_flow(organizer):
    with TestClient(app) as client:
        org = account(client, email=organizer)
        assert client.get("/api/auth/me", headers=org).json()["organizer"] is True
        cid, payload = published(client, org)
        assert client.put(f"/api/circuits/{cid}", headers=org, json=payload).status_code == 409
        assert client.delete(f"/api/circuits/{cid}", headers=org).status_code == 409
        assert any(c["id"] == cid and c["published_at"] for c in client.get("/api/public/circuits").json())

        tag = uuid.uuid4().hex[:6]
        uno_name, dos_name = "Rider Uno " + tag, "Rider Dos " + tag
        uno = account(client)
        assert client.get("/api/auth/me", headers=uno).json()["organizer"] is False
        slow = gpx(recent(30), 2000)
        assert submit(client, uno, cid, slow).status_code == 409  # no rider name yet
        assert client.put("/api/me/profile", headers=uno,
                          json={"display_name": uno_name.replace(" ", "  ", 1)}).json()["display_name"] == uno_name
        dos = account(client)
        assert client.put("/api/me/profile", headers=dos, json={"display_name": uno_name.lower()}).status_code == 409
        assert client.put("/api/me/profile", headers=dos, json={"display_name": dos_name}).status_code == 200

        first = submit(client, uno, cid, slow)
        assert first.status_code == 201, first.text
        entry = first.json()
        assert entry["review_status"] == "pending" and entry["gps_status"] == "compatible"
        assert abs(entry["elapsed_ms"] - 154000) < 1100 and len(entry["sector_splits_ms"]) == 3
        fast = gpx(recent(20), 1700)
        second = submit(client, dos, cid, fast)
        assert second.status_code == 201, second.text
        assert submit(client, dos, cid, fast).status_code == 409   # same file twice
        assert submit(client, uno, cid, fast).status_code == 409   # someone else's file
        assert client.get(f"/api/public/circuits/{cid}/leaderboard").json()["rows"] == []  # pending is not ranked

        assert client.post(f"/api/circuits/{cid}/publish", headers=uno).status_code == 403
        assert client.get("/api/competition/review", headers=uno).status_code == 403
        assert client.post(f"/api/competition/entries/{entry['id']}/review", headers=dos,
                           json={"decision": "approved"}).status_code == 403
        queue = client.get("/api/competition/review", headers=org).json()
        assert {e["pilot"] for e in queue} == {uno_name, dos_name}
        for e in queue:
            r = client.post(f"/api/competition/entries/{e['id']}/review", headers=org, json={"decision": "approved"})
            assert r.status_code == 200, r.text

        board = client.get(f"/api/public/circuits/{cid}/leaderboard")
        assert board.status_code == 200 and "@example.com" not in board.text
        rows = board.json()["rows"]
        assert [r["pilot"] for r in rows] == [dos_name, uno_name]
        assert [r["rank"] for r in rows] == [1, 2] and rows[0]["gap_ms"] == 0 and rows[1]["gap_ms"] > 20000
        assert board.json()["best_sectors_ms"] == rows[0]["sector_splits_ms"]
        assert board.json()["month"] in board.json()["months"]

        client.post(f"/api/competition/entries/{entry['id']}/review", headers=org,
                    json={"decision": "rejected", "note": "Se salta la curva 3"})
        assert [r["pilot"] for r in client.get(f"/api/public/circuits/{cid}/leaderboard").json()["rows"]] == [dos_name]
        mine = client.get("/api/competition/entries", headers=uno).json()
        assert mine[0]["review_status"] == "rejected" and mine[0]["review_note"] == "Se salta la curva 3"

        assert client.get(f"/api/competition/entries/{entry['id']}/file", headers=uno).content == slow
        assert client.get(f"/api/competition/entries/{entry['id']}/file", headers=org).status_code == 200
        assert client.get(f"/api/competition/entries/{entry['id']}/file", headers=dos).status_code == 404
        evidence = client.get("/api/activities", headers=uno).json()[0]["id"]
        assert client.delete(f"/api/activities/{evidence}", headers=uno).status_code == 409

def test_entries_need_a_recent_complete_run(organizer):
    with TestClient(app) as client:
        org = account(client, email=organizer)
        cid, _ = published(client, org)
        rider = account(client, "Tres " + uuid.uuid4().hex[:6])
        assert submit(client, rider, cid, gpx(recent(60 * 24 * 30), 2000)).status_code == 422  # a month old
        assert submit(client, rider, cid, gpx(recent(30), 2000, lat_shift=0.05)).status_code == 422  # another hill
        assert submit(client, rider, cid, b"<gpx/>").status_code == 422
        assert submit(client, rider, cid, gpx(recent(30), 2000), name="bajada.fit").status_code == 422
        assert submit(client, rider, str(uuid.uuid4()), gpx(recent(30), 2000)).status_code == 404
        draft = {"name": "Privado", "points": [[36.74 - i * 0.0001, -4.45, 400] for i in range(20)]}
        assert client.post("/api/circuits", headers=rider, json=draft).status_code == 403  # riders only send runs
        unpublished = client.post("/api/circuits", headers=org, json=draft).json()["id"]
        assert submit(client, rider, unpublished, gpx(recent(30), 2000)).status_code == 404
        assert client.get(f"/api/public/circuits/{unpublished}/leaderboard").status_code == 404
        assert client.get(f"/api/public/circuits/{cid}/leaderboard?month=2026-13").status_code == 422

def test_invite_code_closes_sign_up(monkeypatch):
    with TestClient(app) as client:
        assert client.get("/api/health").json()["invite_required"] is False
    monkeypatch.setattr(config, "INVITE_CODE", "monte-2026")
    with TestClient(app) as client:
        assert client.get("/api/health").json()["invite_required"] is True
        body = {"email": f"rider-{uuid.uuid4().hex}@example.com", "password": "very-long-testing-password"}
        assert client.post("/api/auth/register", json=body).status_code == 403
        assert client.post("/api/auth/register", json={**body, "invite_code": "otro"}).status_code == 403
        assert client.post("/api/auth/register", json={**body, "invite_code": " monte-2026 "}).status_code == 201

def test_login_attempts_are_limited():
    with TestClient(app) as client:
        body = {"email": f"nobody-{uuid.uuid4().hex}@example.com", "password": "wrong-password-123"}
        codes = [client.post("/api/auth/login", json=body).status_code for _ in range(11)]
        assert codes[:10] == [401] * 10 and codes[10] == 429
