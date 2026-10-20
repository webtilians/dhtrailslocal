"""An organizer changes a circuit that a tournament uses: every time follows the new line."""
import uuid

from fastapi.testclient import TestClient

from test_competition import account, gpx, new_tournament, organizer, recent, upload  # noqa: F401 (fixture)
from test_records import area, circuit_at, ride, train
from app.main import app

def shorter(place, name, last=68):
    """The same circuit with its finish 20 points (about 120 m) earlier."""
    ref = ride(place, 0, 0)[10:last]
    return {"name": name, "gateRadius": 18, "points": [[round(lat, 7), round(lon, 7), ele] for lat, lon, ele, _ in ref],
            "sectors": [{"index": 18, "name": "Curvas"}, {"index": 52, "name": "Rock garden"}]}

def test_an_organizer_moves_the_finish_and_every_time_follows(organizer):
    with TestClient(app) as client:
        tag, place = uuid.uuid4().hex[:6], area()
        org = account(client, "Org " + tag, organizer)
        cid = circuit_at(client, org, place, "Meta " + tag)
        tid = new_tournament(client, org, cid)
        rider = account(client, "Uno " + tag)
        entry = upload(client, rider, f"/api/tournaments/{tid}/entries", gpx(ride(place, recent(60), 2000))).json()
        assert entry["review_status"] == "approved"
        trained = train(client, rider, gpx(ride(place, recent(30), 1800)))["runs"][0]["elapsed_ms"]
        listed = next(c for c in client.get("/api/circuits", headers=org).json() if c["id"] == cid)
        assert listed["published"] and listed["can_edit"] and not listed["can_delete"] and listed["entries"] == 1
        assert next(c for c in client.get("/api/circuits", headers=rider).json() if c["id"] == cid)["can_edit"] is False

        # Only an organizer changes it, and it still cannot be deleted.
        assert client.put(f"/api/circuits/{cid}", headers=rider, json=shorter(place, "Meta " + tag)).status_code == 404
        r = client.put(f"/api/circuits/{cid}", headers=org, json=shorter(place, "Meta " + tag))
        assert r.status_code == 200, r.text
        assert client.delete(f"/api/circuits/{cid}", headers=org).status_code == 409

        # The entry, timed again from its file: 20 points of 2 s less, still in the standings and verified.
        row = client.get(f"/api/public/tournaments/{tid}").json()["rows"][0]
        assert abs((entry["elapsed_ms"] - row["elapsed_ms"]) - 40000) <= 1100 and row["verified"] is True
        assert len(row["sector_splits_ms"]) == 3
        # The training run, found again on the new line; both, the same in the records.
        runs = {r["tournament_name"]: r["elapsed_ms"] for r in client.get(f"/api/training/runs?circuit_id={cid}", headers=rider).json()}
        assert abs((trained - runs[None]) - 36000) <= 1100 and runs["Torneo de prueba"] == row["elapsed_ms"]
        board = client.get(f"/api/records/{cid}", headers=rider).json()
        assert board["rows"][0]["elapsed_ms"] == min(runs.values()) and board["not_counted"] == []
        circuit = next(c for c in client.get("/api/public/circuits").json() if c["id"] == cid)
        assert circuit["in_tournament"] is True and len(circuit["points"]) == 58

def test_an_entry_the_new_line_no_longer_fits_leaves_the_standings(organizer):
    with TestClient(app) as client:
        tag, place = uuid.uuid4().hex[:6], area()
        org = account(client, "Org " + tag, organizer)
        cid = circuit_at(client, org, place, "Lejos " + tag)
        tid = new_tournament(client, org, cid)
        rider = account(client, "Dos " + tag)
        # A ride that ends right at the old finish: a longer line is no longer ridden to its finish.
        assert upload(client, rider, f"/api/tournaments/{tid}/entries", gpx(ride(place, recent(60), 2000)[:89])).json()["review_status"] == "approved"
        longer = shorter(place, "Lejos " + tag, last=99)
        assert client.put(f"/api/circuits/{cid}", headers=org, json=longer).status_code == 200
        assert client.get(f"/api/public/tournaments/{tid}").json()["rows"] == []
        mine = client.get(f"/api/tournaments/{tid}/entries/mine", headers=rider).json()[0]
        assert mine["review_status"] == "rejected" and "circuito cambiado" in mine["review_note"]
