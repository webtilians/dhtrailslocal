"""A rider deletes their account and everything of theirs; circuits others use stay, with the organization."""
import uuid

from fastapi.testclient import TestClient

from app import config
from app.main import app
from test_competition import account, circuit_body, fixes, gpx, organizer, recent, upload  # noqa: F401 (fixture)


def test_a_rider_deletes_their_account_and_their_data(organizer):
    with TestClient(app) as client:
        shift = 0.2 + uuid.uuid4().int % 1000 * 0.003   # an area where no other test has a circuit
        org = account(client, email=organizer)
        email = f"rider-{uuid.uuid4().hex}@example.com"
        rider, friend = account(client, email=email), account(client)
        rider_id = client.get("/api/auth/me", headers=rider).json()["id"]
        # The rider draws two circuits; a friend rides one of them.
        alone = client.post("/api/circuits", headers=rider, json=circuit_body("Solo mío", shift)).json()["id"]
        shared = client.post("/api/circuits", headers=rider, json=circuit_body("Compartido", shift + 0.011)).json()["id"]
        assert upload(client, rider, "/api/training/routes", gpx(fixes(recent(90), 1000, shift))).status_code == 201
        assert upload(client, friend, "/api/training/routes", gpx(fixes(recent(60), 1000, shift + 0.011))).status_code == 201
        assert (config.GPS_STORAGE_DIR / rider_id).is_dir()

        wrong = client.post("/api/auth/delete-account", headers=rider, json={"password": "not-the-password"})
        assert wrong.status_code == 403
        assert client.post("/api/auth/delete-account", headers=org, json={"password": "very-long-testing-password"}).status_code == 409
        assert client.post("/api/auth/delete-account", headers=rider, json={"password": "very-long-testing-password"}).status_code == 204

        # The account and its data are gone: no sign-in, no session, no files.
        assert client.post("/api/auth/login", json={"email": email, "password": "very-long-testing-password"}).status_code == 401
        assert client.get("/api/auth/me", headers=rider).status_code == 401
        assert not (config.GPS_STORAGE_DIR / rider_id).exists()
        # The circuit only they rode is gone; the one the friend rode stays, now the organization's.
        circuits = {c["id"]: c for c in client.get("/api/circuits", headers=org).json()}
        assert alone not in circuits
        assert circuits[shared]["mine"] is True
        assert len(client.get(f"/api/training/runs?circuit_id={shared}", headers=friend).json()) == 1
        # Leave no circuit behind: other tests look for empty ground at random.
        assert client.delete(f"/api/circuits/{shared}", headers=org).status_code == 204
