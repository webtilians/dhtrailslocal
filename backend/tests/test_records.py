"""Circuit records: every rider's best run on each circuit, and the hot seat."""
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import null, select, update

from app import main
from app.database import SessionLocal
from app.main import app
from app.models import Attempt
from test_competition import account, fixes, gpx, new_tournament, organizer, recent, upload  # noqa: F401 (fixture)

def area():
    """A place of its own (latitude and longitude), where no other test has routes or circuits."""
    n = uuid.uuid4().int
    return 5 + n % 1000 * 0.01, n // 1000 % 3000 * 0.01

def ride(place, t0, step_ms):
    dlat, dlon = place
    return [(lat + dlat, lon + dlon, ele, t) for lat, lon, ele, t in fixes(t0, step_ms)]

def circuit_at(client, org, place, name):
    ref = ride(place, 0, 0)[10:88]
    r = client.post("/api/circuits", headers=org, json={"name": name, "gateRadius": 18,
        "points": [[round(lat, 7), round(lon, 7), ele] for lat, lon, ele, _ in ref],
        "sectors": [{"index": 18, "name": "Curvas"}, {"index": 52, "name": "Rock garden"}]})
    assert r.status_code == 201, r.text
    return r.json()["id"]

def train(client, rider, data, name="ruta.gpx"):
    r = upload(client, rider, "/api/training/routes", data, name)
    assert r.status_code == 201, r.text
    return r.json()

def test_each_riders_best_run_ranks_and_the_first_holds_the_hot_seat(organizer):
    with TestClient(app) as client:
        tag, place = uuid.uuid4().hex[:6], area()
        org = account(client, "Org " + tag, organizer)
        cid = circuit_at(client, org, place, "Récords " + tag)
        fast, slow = account(client, "Rayo " + tag), account(client, "Tortuga " + tag)

        first = train(client, slow, gpx(ride(place, recent(300), 2000)), "lenta.gpx")
        mine = next(r for r in first["records"] if r["circuit_id"] == cid)
        assert (mine["rank"], mine["riders"], mine["new_best"], mine["gap_ms"]) == (1, 1, True, 0)
        better = train(client, slow, gpx(ride(place, recent(200), 1900)), "mejor.gpx")
        assert next(r for r in better["records"] if r["circuit_id"] == cid)["new_best"] is True
        took = next(r for r in train(client, fast, gpx(ride(place, recent(100), 1700)))["records"] if r["circuit_id"] == cid)
        # The fast one takes the hot seat, ahead of the slow one.
        assert (took["rank"], took["riders"], took["new_best"], took["hot_seat"], took["next"]["pilot"]) == (1, 2, True, True, "Tortuga " + tag)
        worse = train(client, slow, gpx(ride(place, recent(50), 2100)), "peor.gpx")
        behind = next(r for r in worse["records"] if r["circuit_id"] == cid)
        assert behind["rank"] == 2 and behind["new_best"] is False and behind["hot_seat"] is False and behind["gap_ms"] > 0

        board = client.get(f"/api/records/{cid}", headers=slow).json()
        rows = [(r["rank"], r["pilot"], r["mine"], r["runs"]) for r in board["rows"]]
        assert rows == [(1, "Rayo " + tag, False, 1), (2, "Tortuga " + tag, True, 3)]
        assert board["rows"][0]["gap_ms"] == 0 and board["rows"][1]["gap_ms"] == behind["gap_ms"]
        assert board["rows"][1]["elapsed_ms"] == min(r["elapsed_ms"] for r in better["runs"])
        assert board["circuit"]["name"] == "Récords " + tag and board["not_counted"] == [] and board["visible"] is True
        # Three sectors, all of them fastest in the fast rider's run.
        assert [s["pilot"] for s in board["best_sectors"]] == ["Rayo " + tag] * 3

        overview = next(c for c in client.get("/api/records", headers=slow).json()["circuits"] if c["id"] == cid)
        assert overview["hot_seat"]["pilot"] == "Rayo " + tag and overview["riders"] == 2 and overview["me"]["rank"] == 2

        # Among friends only: nobody else until they are friends.
        assert [r["pilot"] for r in client.get(f"/api/records/{cid}?friends=true", headers=slow).json()["rows"]] == ["Tortuga " + tag]
        client.post("/api/friends", headers=slow, json={"display_name": "Rayo " + tag})
        client.post("/api/friends", headers=fast, json={"display_name": "Tortuga " + tag})
        assert len(client.get(f"/api/records/{cid}?friends=true", headers=slow).json()["rows"]) == 2

        # A rider may choose not to appear: the hot seat goes to the next one.
        assert client.put("/api/records/me", headers=fast, json={"visible": False}).json() == {"visible": False}
        assert [r["pilot"] for r in client.get(f"/api/records/{cid}", headers=slow).json()["rows"]] == ["Tortuga " + tag]
        assert client.get(f"/api/records/{cid}", headers=fast).json()["visible"] is False
        assert client.put("/api/records/me", headers=fast, json={"visible": True}).status_code == 200

        # An accepted time trial entry counts too; the same ride sent to training as well is one ride.
        tid = new_tournament(client, org, cid)
        quick = account(client, "Bala " + tag)
        data = gpx(ride(place, recent(30), 1600))
        assert upload(client, quick, f"/api/tournaments/{tid}/entries", data).json()["review_status"] == "approved"
        train(client, quick, data)
        top = client.get(f"/api/records/{cid}", headers=slow).json()["rows"][0]
        assert (top["pilot"], top["tournament"], top["runs"]) == ("Bala " + tag, True, 1)

        assert client.get(f"/api/records/{uuid.uuid4()}", headers=slow).status_code == 404
        assert client.get("/api/records").status_code == 401

def test_runs_that_look_edited_do_not_count(organizer):
    with TestClient(app) as client:
        tag, place = uuid.uuid4().hex[:6], area()
        org = account(client, "Org " + tag, organizer)
        cid = circuit_at(client, org, place, "Limpio " + tag)
        honest, cheat = account(client, "Honrado " + tag), account(client, "Atajo " + tag)
        train(client, honest, gpx(ride(place, recent(300), 2000)))
        edited = gpx(ride(place, recent(200), 1500)).replace(b'<gpx version="1.1">', b'<gpx version="1.1" creator="https://gpx.studio">')
        caught = next(r for r in train(client, cheat, edited)["records"] if r["circuit_id"] == cid)
        assert caught["not_counted"] == 1 and caught["rank"] is None
        assert [r["pilot"] for r in client.get(f"/api/records/{cid}", headers=honest).json()["rows"]] == ["Honrado " + tag]
        # The rider sees that it does not count; only the organization sees why.
        theirs = client.get(f"/api/records/{cid}", headers=cheat).json()["not_counted"]
        assert [(r["mine"], "reasons" in r) for r in theirs] == [(True, False)]
        assert client.get(f"/api/records/{cid}", headers=honest).json()["not_counted"] == []
        seen = client.get(f"/api/records/{cid}", headers=org).json()["not_counted"]
        assert seen[0]["pilot"] == "Atajo " + tag and "gpx.studio" in " ".join(seen[0]["reasons"])

        # The route the app writes from a GoPro's GPS has ten fixes a second, and still counts.
        camera = [(lat, lon, ele, recent(100) + i * 1750) for i, (lat, lon, ele, _) in enumerate(ride(place, 0, 0))]
        gopro = gpx(camera).replace(b'<gpx version="1.1">', b'<gpx version="1.1" creator="DH Trails (GoPro HERO13 Black)">')
        assert next(r for r in train(client, account(client, "Camara " + tag), gopro, "GX01 (GPS de la GoPro).gpx")["records"]
                    if r["circuit_id"] == cid)["rank"] == 1

def test_training_runs_from_before_the_checks_are_checked_once(organizer):
    with TestClient(app) as client:
        tag, place = uuid.uuid4().hex[:6], area()
        org = account(client, "Org " + tag, organizer)
        cid = circuit_at(client, org, place, "Antiguo " + tag)
        main.register_limit.reset()
        old, edited_old = account(client, "Viejo " + tag), account(client, "Retocado " + tag)
        train(client, old, gpx(ride(place, recent(300), 2000)))
        edited = gpx(ride(place, recent(200), 1500)).replace(b'<gpx version="1.1">', b'<gpx version="1.1" creator="GPS Visualizer">')
        train(client, edited_old, edited)
        # As stored before training runs were checked (an SQL NULL, not a JSON null).
        with SessionLocal() as db:
            db.execute(update(Attempt).where(Attempt.circuit_id == uuid.UUID(cid)).values(checks=null()))
            db.commit()
        assert [r["pilot"] for r in client.get(f"/api/records/{cid}", headers=old).json()["rows"]] == ["Viejo " + tag]
        with SessionLocal() as db:
            checks = {str(a.pilot_id): a.checks for a in db.scalars(select(Attempt).where(Attempt.circuit_id == uuid.UUID(cid))).all()}
        assert sorted(len(c) for c in checks.values()) == [0, 1]
