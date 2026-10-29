"""The board: friends' training, everyone's time trials and hot seats, 🔥, comments, reports and blocks."""
import uuid

from fastapi.testclient import TestClient

from app.main import app
from test_competition import account, fixes, free_area, gpx, new_circuit, new_tournament, organizer, recent, upload  # noqa: F401 (fixture)

def ride(client, headers, minutes_ago, step_ms, shift):
    r = upload(client, headers, "/api/training/routes", gpx(fixes(recent(minutes_ago), step_ms, shift)))
    assert r.status_code == 201, r.text

def posts(client, headers, cid):
    return [p for p in client.get("/api/feed", headers=headers).json()["posts"] if p["circuit_id"] == cid]

def kinds(board):
    return sorted((p["kind"], p["pilot"]) for p in board)

def me(client, headers):
    return client.get("/api/auth/me", headers=headers).json()["id"]

def test_the_board_shows_friends_training_and_everyones_hot_seats(organizer):
    with TestClient(app) as client:
        tag, shift = uuid.uuid4().hex[:6], free_area()
        org = account(client, "Org " + tag, organizer)
        cid = new_circuit(client, org, "Tablón " + tag, shift)
        ana, leo, eva = account(client, "Ana " + tag), account(client, "Leo " + tag), account(client, "Eva " + tag)
        ride(client, ana, 3 * 24 * 60, 2000, shift)   # three days ago
        ride(client, ana, 60, 1800, shift)            # today, faster: her best
        ride(client, leo, 30, 1700, shift)            # Leo's, faster still: the hot seat
        ANA, LEO = "Ana " + tag, "Leo " + tag

        # Training is for friends only; the hot seats and the organization's circuit are everyone's.
        public = [("circuit", "Org " + tag), ("seat", ANA), ("seat", ANA), ("seat", LEO)]
        assert kinds(posts(client, eva, cid)) == sorted(public)
        assert kinds(posts(client, leo, cid)) == sorted(public + [("train", LEO)])
        seats = [p for p in posts(client, eva, cid) if p["kind"] == "seat"]
        assert seats[0]["pilot"] == LEO and seats[0]["previous"]["pilot"] == ANA and not seats[0]["previous"]["same"]
        assert seats[1]["previous"]["same"] and seats[2]["previous"] is None

        ana_id = me(client, ana)
        assert client.post("/api/friends", headers=leo, json={"display_name": ANA}).status_code == 201
        assert client.post(f"/api/friends/{me(client, leo)}/accept", headers=ana).status_code == 200
        training = [p for p in posts(client, leo, cid) if p["kind"] == "train" and p["pilot"] == ANA]
        today, before = training
        assert before["first"] and not before["personal_best"] and before["previous_best_ms"] is None
        assert today["personal_best"] and today["previous_best_ms"] == before["elapsed_ms"] > today["elapsed_ms"]
        assert today["runs"] == 1 and today["key"].startswith(f"train:{ana_id}:{cid}:")
        # A friend's post never says where the run's file came from.
        assert "source_filename" not in today and "activity_id" not in today

        # 🔥 and comments, seen by whoever sees the post.
        r = client.post("/api/feed/reactions", headers=leo, json={"post": today["key"]})
        assert r.status_code == 200 and r.json() == {"count": 1, "mine": True, "names": [LEO]}
        assert client.post("/api/feed/reactions", headers=eva, json={"post": today["key"]}).status_code == 404
        assert client.post("/api/feed/reactions", headers=eva, json={"post": seats[0]["key"]}).json()["count"] == 1
        assert client.post("/api/feed/reactions", headers=eva, json={"post": "train:nada"}).status_code == 404
        said = client.post("/api/feed/comments", headers=leo, json={"post": today["key"], "text": "  ¡Vaya   bajada!  "})
        assert said.status_code == 201 and said.json()["text"] == "¡Vaya bajada!"
        assert client.post("/api/feed/comments", headers=eva, json={"post": today["key"], "text": "hola"}).status_code == 404
        for bad in ("eres un gilipollas", "H1J0 DE PUTA", "Subnormal!!"):
            assert client.post("/api/feed/comments", headers=leo, json={"post": today["key"], "text": bad}).status_code == 422
        # Riders' everyday swearing among friends is fine.
        assert client.post("/api/feed/comments", headers=leo, json={"post": today["key"], "text": "eres el puto amo"}).status_code == 201
        mine = next(p for p in posts(client, ana, cid) if p["key"] == today["key"])
        assert mine["reactions"] == {"count": 1, "mine": False, "names": [LEO]}
        assert [c["text"] for c in mine["comments"]] == ["¡Vaya bajada!", "eres el puto amo"]
        assert all(c["can_delete"] and not c["mine"] for c in mine["comments"])

        # Whoever reports a comment stops seeing it; the organization decides.
        comment_id = said.json()["id"]
        assert client.post(f"/api/feed/comments/{comment_id}/report", headers=leo).status_code == 422
        assert client.post(f"/api/feed/comments/{comment_id}/report", headers=ana).status_code == 204
        assert client.post(f"/api/feed/comments/{comment_id}/report", headers=ana).status_code == 204
        text = lambda h: [c["text"] for p in posts(client, h, cid) if p["key"] == today["key"] for c in p["comments"]]
        assert text(ana) == ["eres el puto amo"] and text(leo) == ["¡Vaya bajada!", "eres el puto amo"]
        assert client.get("/api/feed/reports", headers=ana).status_code == 403
        reported = [c for c in client.get("/api/feed/reports", headers=org).json() if c["id"] == comment_id]
        assert reported and reported[0]["reports"] == 1 and reported[0]["post"] == today["key"]
        assert client.post(f"/api/feed/comments/{comment_id}/keep", headers=org).status_code == 204
        assert text(ana) == ["¡Vaya bajada!", "eres el puto amo"]
        assert client.delete(f"/api/feed/comments/{comment_id}", headers=eva).status_code == 403
        assert client.delete(f"/api/feed/comments/{comment_id}", headers=ana).status_code == 204
        assert text(leo) == ["eres el puto amo"]

        # Blocking: neither sees the other on the board, they stop being friends and can't ask again.
        blocked = client.post("/api/feed/blocks", headers=ana, json={"pilot_id": me(client, leo)})
        assert blocked.status_code == 201 and client.get("/api/feed/blocks", headers=ana).json() == [blocked.json()]
        assert LEO not in {p["pilot"] for p in posts(client, ana, cid)} and ANA not in {p["pilot"] for p in posts(client, leo, cid)}
        assert all(not p["comments"] and not p["reactions"]["count"] for p in posts(client, ana, cid) if p["kind"] == "train")
        assert client.get("/api/friends", headers=ana).json()["friends"] == []
        assert client.post("/api/friends", headers=leo, json={"display_name": ANA}).status_code == 404
        assert client.post("/api/feed/comments", headers=leo, json={"post": today["key"], "text": "hola"}).status_code == 404
        assert client.post("/api/feed/blocks", headers=ana, json={"pilot_id": ana_id}).status_code == 422
        assert client.delete(f"/api/feed/blocks/{me(client, leo)}", headers=ana).status_code == 204
        assert ("seat", LEO) in kinds(posts(client, ana, cid)) and ("train", LEO) not in kinds(posts(client, ana, cid))

        # Deleting an account takes its 🔥 and comments with it.
        assert text(ana) == ["eres el puto amo"]
        assert client.post("/api/auth/delete-account", headers=leo, json={"password": "very-long-testing-password"}).status_code == 204
        mine = next(p for p in posts(client, ana, cid) if p["key"] == today["key"])
        assert mine["comments"] == [] and mine["reactions"]["count"] == 0

def test_time_trial_entries_go_on_everyones_board_with_their_place(organizer):
    with TestClient(app) as client:
        tag, shift = uuid.uuid4().hex[:6], free_area()
        org = account(client, "Org " + tag, organizer)
        cid = new_circuit(client, org, "Torneo " + tag, shift)
        tid = new_tournament(client, org, cid)
        uno, dos, otro = account(client, "Uno " + tag), account(client, "Dos " + tag), account(client, "Otro " + tag)
        assert upload(client, uno, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(40), 2000, shift))).json()["review_status"] == "approved"
        entry = lambda: {p["pilot"]: p for p in posts(client, otro, cid) if p["kind"] == "entry"}
        assert entry()["Uno " + tag]["rank"] == 1 and entry()["Uno " + tag]["riders"] == 1
        assert upload(client, dos, f"/api/tournaments/{tid}/entries", gpx(fixes(recent(20), 1700, shift))).json()["review_status"] == "approved"
        board = entry()
        assert (board["Dos " + tag]["rank"], board["Uno " + tag]["rank"], board["Uno " + tag]["riders"]) == (1, 2, 2)
        assert board["Uno " + tag]["tournament"] == {"id": tid, "name": "Torneo de prueba"} and board["Uno " + tag]["its_best"]
        # A time trial entry counts for the records as well: it takes the hot seat too.
        assert ("seat", "Dos " + tag) in kinds(posts(client, otro, cid))
        # The newest first, a page at a time.
        page = client.get("/api/feed", headers=otro).json()
        stamps = [p["at"] for p in page["posts"]]
        assert stamps == sorted(stamps, reverse=True)
        if page["next"]:
            more = client.get("/api/feed", headers=otro, params={"before": page["next"]}).json()["posts"]
            assert more and all(p["at"] < page["next"] for p in more)
