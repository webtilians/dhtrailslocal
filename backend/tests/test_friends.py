"""Friends compare their training runs; nothing is shared until both agree."""
import uuid

from fastapi.testclient import TestClient

from app.main import app
from test_competition import account, fixes, gpx, new_circuit, organizer, recent, upload  # noqa: F401 (fixture)

def test_friends_see_each_others_training_runs_only_once_accepted(organizer):
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        org = account(client, "Org " + tag, organizer)
        cid = new_circuit(client, org, "Tuliki " + tag)
        ana, leo, eva = account(client, "Ana " + tag), account(client, "Leo " + tag), account(client, "Eva " + tag)
        assert upload(client, ana, "/api/training/routes", gpx(fixes(recent(90), 2000)), "ana.gpx").status_code == 201
        assert upload(client, leo, "/api/training/routes", gpx(fixes(recent(60), 1700)), "leo.gpx").status_code == 201
        runs = lambda h: client.get(f"/api/training/runs?circuit_id={cid}&friends=true", headers=h).json()
        pilots = lambda h: {r["pilot"] for r in runs(h)}
        assert pilots(ana) == {"Ana " + tag}

        # A pending request shares nothing; the name is matched without caring about case.
        asked = client.post("/api/friends", headers=ana, json={"display_name": "leo " + tag})
        assert asked.status_code == 201 and asked.json() == {"status": "pending", "name": "Leo " + tag}
        assert pilots(ana) == {"Ana " + tag}
        assert [f["name"] for f in client.get("/api/friends", headers=leo).json()["incoming"]] == ["Ana " + tag]
        assert client.post("/api/friends", headers=ana, json={"display_name": "Leo " + tag}).status_code == 409
        assert client.post("/api/friends", headers=ana, json={"display_name": "Nadie " + tag}).status_code == 404
        assert client.post("/api/friends", headers=ana, json={"display_name": "Ana " + tag}).status_code == 422
        assert client.post("/api/friends", headers=account(client), json={"display_name": "Ana " + tag}).status_code == 409

        ana_id = client.get("/api/auth/me", headers=ana).json()["id"]
        assert client.post(f"/api/friends/{ana_id}/accept", headers=leo).status_code == 200
        assert pilots(ana) == pilots(leo) == {"Ana " + tag, "Leo " + tag}
        leos = next(r for r in runs(ana) if not r["mine"])
        # A friend sees the run on the circuit, never which file or route it came from.
        assert leos["source_filename"] is None and leos["activity_id"] is None
        assert client.get(f"/api/training/runs/{leos['id']}", headers=ana).json()["profile"]
        assert client.get(f"/api/training/runs/{leos['id']}", headers=eva).status_code == 404
        assert {r["pilot"] for r in client.get(f"/api/training/runs?circuit_id={cid}", headers=ana).json()} == {"Ana " + tag}
        assert [f["name"] for f in client.get("/api/friends", headers=ana).json()["friends"]] == ["Leo " + tag]

        # Asking back accepts at once; removing a friend ends the sharing for both.
        assert client.post("/api/friends", headers=eva, json={"display_name": "Ana " + tag}).status_code == 201
        assert client.post("/api/friends", headers=ana, json={"display_name": "Eva " + tag}).json()["status"] == "accepted"
        leo_id = client.get("/api/auth/me", headers=leo).json()["id"]
        assert client.delete(f"/api/friends/{leo_id}", headers=ana).status_code == 204
        assert "Leo " + tag not in pilots(ana) and "Ana " + tag not in pilots(leo)
        assert client.get(f"/api/training/runs/{leos['id']}", headers=ana).status_code == 404
        assert client.delete(f"/api/friends/{leo_id}", headers=ana).status_code == 404
