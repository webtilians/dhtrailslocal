"""Groups: riders out together see each other on a map, only once they accept and only while they share it."""
import uuid
from datetime import timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select, update

from app.database import SessionLocal
from app.main import app
from app.models import PilotLocation
from test_competition import account

def me(client, headers):
    return client.get("/api/auth/me", headers=headers).json()["id"]

def members(client, headers, gid):
    return {m["name"]: m for m in client.get(f"/api/groups/{gid}", headers=headers).json()["members"]}

HERE = {"lat": 36.7601, "lon": -4.4602, "ele": 820.0, "accuracy": 6.0, "speed": 3.2}

def test_a_group_sees_where_its_riders_are_only_once_they_accept_and_share():
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        GUIA, ANA, LEO, EVA = "Guía " + tag, "Ana " + tag, "Leo " + tag, "Eva " + tag
        guia, ana, leo, eva = account(client, GUIA), account(client, ANA), account(client, LEO), account(client, EVA)
        ana_id, leo_id = me(client, ana), me(client, leo)

        # A rider without a name can't create one: the group would not know who they are.
        assert client.post("/api/groups", headers=account(client), json={"name": "x"}).status_code == 409
        assert client.post("/api/groups", headers=guia, json={"name": "   "}).status_code == 422
        made = client.post("/api/groups", headers=guia, json={"name": "  Ruta   del sábado "})
        assert made.status_code == 201 and made.json()["name"] == "Ruta del sábado"
        gid = made.json()["id"]

        # Invited by name; until they accept, they see only the invitation, and nobody sees them.
        r = client.post(f"/api/groups/{gid}/members", headers=guia, json={"display_name": "ana " + tag})
        assert r.status_code == 201 and r.json() == {"status": "invited", "name": ANA}
        assert client.post(f"/api/groups/{gid}/members", headers=guia, json={"display_name": ANA}).status_code == 409
        assert client.post(f"/api/groups/{gid}/members", headers=guia, json={"display_name": GUIA}).status_code == 422
        assert client.post(f"/api/groups/{gid}/members", headers=guia, json={"display_name": "Nadie " + tag}).status_code == 404
        assert client.post(f"/api/groups/{gid}/members", headers=guia, json={"display_name": LEO}).status_code == 201
        invited = client.get("/api/groups", headers=ana).json()
        assert invited["groups"] == [] and [(i["name"], i["invited_by"]) for i in invited["invitations"]] == [("Ruta del sábado", GUIA)]
        assert client.get(f"/api/groups/{gid}", headers=ana).status_code == 404
        assert client.get(f"/api/groups/{gid}", headers=eva).status_code == 404
        assert client.post("/api/location", headers=ana, json=HERE).status_code == 409

        assert client.post(f"/api/groups/{gid}/accept", headers=ana).status_code == 200
        assert client.post(f"/api/groups/{gid}/accept", headers=ana).status_code == 404
        assert client.post(f"/api/groups/{gid}/accept", headers=eva).status_code == 404
        # Only whoever created it invites, marks roles, takes riders out or deletes it.
        assert client.post(f"/api/groups/{gid}/members", headers=ana, json={"display_name": EVA}).status_code == 403
        assert client.put(f"/api/groups/{gid}/members/{ana_id}/role", headers=ana, json={"role": "guide"}).status_code == 403
        assert client.delete(f"/api/groups/{gid}/members/{leo_id}", headers=ana).status_code == 403
        assert client.delete(f"/api/groups/{gid}", headers=ana).status_code == 403

        seen = members(client, guia, gid)
        assert set(seen) == {GUIA, ANA, LEO} and seen[LEO]["accepted"] is False and seen[GUIA]["owner"]
        assert all(m["position"] is None for m in seen.values())

        # Accepted, but not sharing: still nowhere on the map.
        assert client.post("/api/location", headers=ana, json=HERE).status_code == 409
        assert client.put(f"/api/groups/{gid}/sharing", headers=ana, json={"sharing": True}).json() == {"sharing": True}
        assert client.post("/api/location", headers=ana, json=HERE).status_code == 204
        assert client.post("/api/location", headers=ana, json={**HERE, "lat": 95}).status_code == 422
        seen = members(client, guia, gid)
        where = seen[ANA]["position"]
        assert seen[ANA]["sharing"] and where["lat"] == HERE["lat"] and where["ele"] == 820.0 and where["age_s"] <= 5
        assert client.get("/api/groups", headers=ana).json()["groups"][0]["sharing"] is True

        # The guide and the van driver, marked by whoever created it.
        guia_id = me(client, guia)
        assert client.put(f"/api/groups/{gid}/members/{guia_id}/role", headers=guia, json={"role": "guide"}).json() == {"role": "guide"}
        assert client.put(f"/api/groups/{gid}/members/{ana_id}/role", headers=guia, json={"role": "shuttle"}).status_code == 200
        assert client.put(f"/api/groups/{gid}/members/{ana_id}/role", headers=guia, json={"role": "chef"}).status_code == 422
        assert client.put(f"/api/groups/{gid}/members/{me(client, eva)}/role", headers=guia, json={"role": "guide"}).status_code == 404
        seen = members(client, ana, gid)
        assert seen[GUIA]["role"] == "guide" and seen[ANA]["role"] == "shuttle" and seen[LEO]["role"] is None

        # Meeting points: anyone in the group puts them; whoever put one, or the group's creator, takes it away.
        p = client.post(f"/api/groups/{gid}/points", headers=ana, json={"name": " Remonte  12:30 ", "lat": 36.77, "lon": -4.45})
        assert p.status_code == 201 and p.json()["name"] == "Remonte 12:30"
        assert client.post(f"/api/groups/{gid}/points", headers=eva, json={"name": "x", "lat": 36.77, "lon": -4.45}).status_code == 404
        q = client.post(f"/api/groups/{gid}/points", headers=guia, json={"name": "Bar", "lat": 36.78, "lon": -4.44}).json()
        points = client.get(f"/api/groups/{gid}", headers=ana).json()["points"]
        assert [(x["name"], x["by"], x["can_delete"]) for x in points] == [("Remonte 12:30", ANA, True), ("Bar", GUIA, False)]
        assert client.delete(f"/api/groups/{gid}/points/{q['id']}", headers=ana).status_code == 403
        assert client.delete(f"/api/groups/{gid}/points/{p.json()['id']}", headers=guia).status_code == 204
        assert [x["name"] for x in client.get(f"/api/groups/{gid}", headers=ana).json()["points"]] == ["Bar"]

        # Stopping sharing forgets the place at once.
        assert client.put(f"/api/groups/{gid}/sharing", headers=ana, json={"sharing": False}).status_code == 200
        assert members(client, guia, gid)[ANA]["position"] is None
        with SessionLocal() as db:
            assert db.get(PilotLocation, uuid.UUID(ana_id)) is None
        assert client.post("/api/location", headers=ana, json=HERE).status_code == 409

        # A place not sent again for hours is no longer shown.
        assert client.put(f"/api/groups/{gid}/sharing", headers=ana, json={"sharing": True}).status_code == 200
        assert client.post("/api/location", headers=ana, json=HERE).status_code == 204
        with SessionLocal() as db:
            db.execute(update(PilotLocation).where(PilotLocation.pilot_id == uuid.UUID(ana_id))
                       .values(updated_at=PilotLocation.updated_at - timedelta(hours=4)))
            db.commit()
        assert members(client, guia, gid)[ANA]["position"] is None

        # Leaving: the rider goes, and so does their place; the creator can't leave, only delete it.
        assert client.delete(f"/api/groups/{gid}/members/{guia_id}", headers=guia).status_code == 409
        assert client.delete(f"/api/groups/{gid}/members/{leo_id}", headers=leo).status_code == 204   # turns it down
        assert client.delete(f"/api/groups/{gid}/members/{ana_id}", headers=ana).status_code == 204
        assert set(members(client, guia, gid)) == {GUIA}
        with SessionLocal() as db:
            assert db.get(PilotLocation, uuid.UUID(ana_id)) is None

        assert client.delete(f"/api/groups/{gid}", headers=guia).status_code == 204
        assert client.get(f"/api/groups/{gid}", headers=guia).status_code == 404
        assert client.get("/api/groups", headers=guia).json() == {"groups": [], "invitations": []}

def test_sharing_with_one_group_shows_the_place_there_and_not_in_another():
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        a, b, c = account(client, "Uno " + tag), account(client, "Dos " + tag), account(client, "Tres " + tag)
        club = client.post("/api/groups", headers=a, json={"name": "Club"}).json()["id"]
        amigos = client.post("/api/groups", headers=c, json={"name": "Amigos"}).json()["id"]
        client.post(f"/api/groups/{club}/members", headers=a, json={"display_name": "Dos " + tag})
        client.post(f"/api/groups/{amigos}/members", headers=c, json={"display_name": "Dos " + tag})
        client.post(f"/api/groups/{club}/accept", headers=b)
        client.post(f"/api/groups/{amigos}/accept", headers=b)
        assert client.put(f"/api/groups/{club}/sharing", headers=b, json={"sharing": True}).status_code == 200
        assert client.post("/api/location", headers=b, json=HERE).status_code == 204
        assert members(client, a, club)["Dos " + tag]["position"] is not None
        assert members(client, c, amigos)["Dos " + tag]["position"] is None
        # Taken out of the only group it shared with: the place goes too.
        assert client.delete(f"/api/groups/{club}/members/{me(client, b)}", headers=a).status_code == 204
        with SessionLocal() as db:
            assert db.scalar(select(PilotLocation).where(PilotLocation.pilot_id == uuid.UUID(me(client, b)))) is None

def test_a_blocked_rider_cannot_be_invited():
    with TestClient(app) as client:
        tag = uuid.uuid4().hex[:6]
        a, b = account(client, "Uno " + tag), account(client, "Dos " + tag)
        gid = client.post("/api/groups", headers=a, json={"name": "Club"}).json()["id"]
        assert client.post("/api/feed/blocks", headers=b, json={"pilot_id": me(client, a)}).status_code in (200, 201, 204)
        assert client.post(f"/api/groups/{gid}/members", headers=a, json={"display_name": "Dos " + tag}).status_code == 404
