"""Time trial tournaments and training against PostgreSQL."""
import math
import time
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app

def fixes(t0_ms, step_ms, lat_shift=0.0):
    return [(36.74 - i * 0.000061 + lat_shift, -4.45 + math.sin(i / 11) * 0.000094, 430 - i * 1.3, t0_ms + i * step_ms)
            for i in range(100)]

def gpx(points):
    body = "".join(
        f'<trkpt lat="{lat}" lon="{lon}"><ele>{ele}</ele><time>'
        f'{datetime.fromtimestamp(t / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3]}Z</time></trkpt>'
        for lat, lon, ele, t in points)
    return f'<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>{body}</trkseg></trk></gpx>'.encode()

def recent(minutes):
    return (time.time() - minutes * 60) * 1000

def account(client, name=None, email=None):
    email = email or f"rider-{uuid.uuid4().hex}@example.com"
    body = {"email": email, "password": "very-long-testing-password"}
    if name:
        body["display_name"] = name
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 201, r.text
    return {"Authorization": "Bearer " + r.json()["access_token"]}

def upload(client, headers, path, data, name="bajada.gpx"):
    return client.post(path, headers=headers, files={"file": (name, data, "application/gpx+xml")})

def circuit_body(name, lat_shift=0.0):
    ref = fixes(0, 0, lat_shift)[10:88]
    return {"name": name, "points": [[round(lat, 7), round(lon, 7), ele] for lat, lon, ele, _ in ref],
            "sectors": [{"index": 18, "name": "Curvas"}, {"index": 52, "name": "Rock garden"}], "gateRadius": 18}

def new_circuit(client, org, name="Santa Cruz DH", lat_shift=0.0):
    r = client.post("/api/circuits", headers=org, json=circuit_body(name, lat_shift))
    assert r.status_code == 201, r.text
    return r.json()["id"]

def new_tournament(client, org, cid, start=-5, end=5, min_match=0.85):
    today = date.today()
    r = client.post("/api/tournaments", headers=org, json={
        "name": "Torneo de prueba", "circuit_id": cid, "min_match": min_match,
        "starts_on": (today + timedelta(days=start)).isoformat(), "ends_on": (today + timedelta(days=end)).isoformat()})
    assert r.status_code == 201, r.text
    return r.json()["id"]

@pytest.fixture
def organizer(monkeypatch):
    email = f"org-{uuid.uuid4().hex}@example.com"
    monkeypatch.setattr(config, "ORGANIZER_EMAILS", {email})
    return email

def test_time_trial_enters_valid_runs_automatically(organizer):
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        org = account(client, "Org " + tag, organizer)
        cid = new_circuit(client, org)
        rider = account(client, "Uno " + tag)
        other = account(client, "Dos " + tag)
        assert client.post("/api/tournaments", headers=rider, json={"name": "x", "circuit_id": cid,
            "starts_on": "2026-10-01", "ends_on": "2026-10-31"}).status_code == 403
        tid = new_tournament(client, org, cid)
        # The circuit is frozen while a tournament uses it.
        assert client.put(f"/api/circuits/{cid}", headers=org, json=circuit_body("Otro")).status_code == 409
        assert next(c for c in client.get("/api/public/circuits").json() if c["id"] == cid)["in_tournament"] is True
        assert any(t["id"] == tid and t["state"] == "activo" for t in client.get("/api/public/tournaments").json())

        slow = gpx(fixes(recent(30), 2000))
        first = upload(client, rider, f"/api/tournaments/{tid}/entries", slow)
        assert first.status_code == 201, first.text
        assert first.json()["review_status"] == "approved" and first.json()["match"] >= 0.85
        assert abs(first.json()["elapsed_ms"] - 154000) < 1100
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", slow).status_code == 409
        fast = upload(client, other, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(20), 1700)))
        assert fast.json()["review_status"] == "approved"

        # A shortcut while the GPS is lost: stored, rejected with the reason, out of the standings.
        points = fixes(recent(10), 1500)
        cut = points[:61] + [(lat, lon, ele, t - 22500) for lat, lon, ele, t in points[80:]]
        third = account(client, "Tres " + tag)
        shortcut = upload(client, third, f"/api/tournaments/{tid}/entries", gpx(cut))
        assert shortcut.status_code == 201, shortcut.text
        assert shortcut.json()["review_status"] == "rejected" and "¿atajo" in shortcut.json()["review_note"]

        board = client.get(f"/api/public/tournaments/{tid}")
        assert board.status_code == 200 and "@example.com" not in board.text
        rows = board.json()["rows"]
        assert [r["pilot"] for r in rows] == ["Dos " + tag, "Uno " + tag]
        assert rows[0]["gap_ms"] == 0 and rows[1]["gap_ms"] > 20000
        assert board.json()["best_sectors_ms"] == rows[0]["sector_splits_ms"]

        # The organizer has the last word.
        assert client.get(f"/api/tournaments/{tid}/entries", headers=rider).status_code == 403
        assert len(client.get(f"/api/tournaments/{tid}/entries", headers=org).json()) == 3
        assert client.post(f"/api/entries/{shortcut.json()['id']}/review", headers=rider,
                           json={"decision": "approved"}).status_code == 403
        assert client.post(f"/api/entries/{shortcut.json()['id']}/review", headers=org,
                           json={"decision": "approved"}).status_code == 200
        assert len(client.get(f"/api/public/tournaments/{tid}").json()["rows"]) == 3
        assert client.get(f"/api/tournaments/{tid}/entries/mine", headers=third).json()[0]["review_status"] == "approved"
        assert client.get(f"/api/entries/{first.json()['id']}/file", headers=rider).content == slow
        assert client.get(f"/api/entries/{first.json()['id']}/file", headers=other).status_code == 404
        assert client.get(f"/api/entries/{first.json()['id']}/file", headers=org).status_code == 200
        assert client.delete(f"/api/tournaments/{tid}", headers=org).status_code == 409

def test_entries_must_follow_the_circuit_within_the_dates(organizer):
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        org = account(client, "Org " + tag, organizer)
        cid = new_circuit(client, org)
        tid = new_tournament(client, org, cid)
        rider = account(client, "Cuatro " + tag)
        nameless = account(client)
        assert upload(client, nameless, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(30), 2000))).status_code == 409
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(60 * 24 * 30), 2000))).status_code == 422
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(30), 2000, 0.05))).status_code == 422
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", b"<gpx/>").status_code == 422
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(30), 2000)), "x.fit").status_code == 422
        future = new_tournament(client, org, cid, start=10, end=20)
        assert "empieza" in upload(client, rider, f"/api/tournaments/{future}/entries", gpx(fixes(recent(30), 2000))).text
        # Deleting the tournaments without entries frees the circuit again once none is left.
        assert client.delete(f"/api/tournaments/{future}", headers=org).status_code == 204
        assert client.delete(f"/api/tournaments/{tid}", headers=org).status_code == 204
        assert client.put(f"/api/circuits/{cid}", headers=org, json=circuit_body("Libre otra vez")).status_code == 200
        assert client.get(f"/api/public/tournaments/{tid}").status_code == 404

def test_training_finds_saved_circuits_in_any_route(organizer):
    with TestClient(app) as client:
        org = account(client, email=organizer)
        here = new_circuit(client, org, "Kawasaki")
        far = new_circuit(client, org, "Tuliki", lat_shift=0.05)
        rider = account(client)
        route = gpx(fixes(recent(90), 2000) + fixes(recent(60), 1700))
        r = upload(client, rider, "/api/training/routes", route, "entreno.gpx")
        assert r.status_code == 201, r.text
        # Other tests leave circuits with the same line in this database: check only ours.
        found = {c["circuit_id"]: (c["circuit_name"], c["runs"]) for c in r.json()["found"]}
        assert found[here] == ("Kawasaki", 2) and far not in found
        assert upload(client, rider, "/api/training/routes", route).status_code == 409
        runs = client.get(f"/api/training/runs?circuit_id={here}", headers=rider).json()
        assert len(runs) == 2 and runs[0]["elapsed_ms"] < runs[1]["elapsed_ms"]
        detail = client.get(f"/api/training/runs/{runs[0]['id']}", headers=rider).json()
        profile = detail["profile"]
        assert profile[0][:2] == [0, 0] and len(profile) > 20
        assert abs(profile[-1][1] - runs[0]["elapsed_ms"]) <= 1
        assert client.get(f"/api/training/runs/{runs[0]['id']}", headers=org).status_code == 404
        routes = client.get("/api/training/routes", headers=rider).json()
        assert len(routes) == 1 and routes[0]["filename"] == "entreno.gpx" and routes[0]["runs"] >= 2
        # Training never touches any standings.
        tid = new_tournament(client, org, here)
        assert client.get(f"/api/public/tournaments/{tid}").json()["rows"] == []
        assert client.delete(f"/api/training/routes/{routes[0]['id']}", headers=rider).status_code == 204
        assert client.get("/api/training/runs", headers=rider).json() == []

def test_sign_up_takes_the_rider_name():
    with TestClient(app) as client:
        name = "Nombre " + uuid.uuid4().hex[:6]
        headers = account(client, name)
        assert client.get("/api/auth/me", headers=headers).json()["display_name"] == name
        again = client.post("/api/auth/register", json={"email": f"x-{uuid.uuid4().hex}@example.com",
                                                        "password": "very-long-testing-password", "display_name": name.upper()})
        assert again.status_code == 409

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
