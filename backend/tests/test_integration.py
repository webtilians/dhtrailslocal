"""Integration tests require PostgreSQL and the first Alembic migration."""
from __future__ import annotations

import uuid
import pytest
from fastapi.testclient import TestClient
from app import config
from app.main import app

@pytest.fixture
def organizers(monkeypatch):
    # Accounts registered through admin() become organizers: only they may create circuits.
    emails=set()
    monkeypatch.setattr(config,"ORGANIZER_EMAILS",emails)
    return emails

def pilot(client,organizers=None):
    email=f"rider-{uuid.uuid4().hex}@example.com"
    if organizers is not None:organizers.add(email)
    p=client.post("/api/auth/register",json={"email":email,"password":"very-long-testing-password"})
    assert p.status_code==201,p.text
    return {"Authorization":"Bearer "+p.json()["access_token"]}

def circuit_payload(name="Santa Cruz"):
    points=[[36.75-i*.00007,-4.44+i*.00004,400-i] for i in range(35)]
    return {"name":name,"points":points,
      "sectors":[{"index":10,"name":"Curvas"},{"index":22,"name":"Zona rápida"}],
      "weakZones":[{"from":12,"to":15,"name":"Mala señal"}],
      "gateRadius":18}

def test_only_organizers_create_circuits(organizers):
    with TestClient(app) as client:
        rider=pilot(client)
        assert client.post("/api/circuits",json=circuit_payload(),headers=rider).status_code==403
        assert client.get("/api/auth/me",headers=rider).json()["organizer"] is False

def test_auth_circuit_persistence_and_tenant_isolation(organizers):
    with TestClient(app) as client:
        a=pilot(client,organizers);b=pilot(client,organizers)
        created=client.post("/api/circuits",json=circuit_payload(),headers=a)
        assert created.status_code==201,created.text
        cid=created.json()["id"]
        assert len(created.json()["sectors"])==2
        assert created.json()["weakZones"][0]["name"]=="Mala señal"
        mine=client.get("/api/circuits",headers=a)
        assert mine.status_code==200 and any(x["id"]==cid for x in mine.json())
        assert client.get(f"/api/circuits/{cid}",headers=b).status_code==404
        assert client.get("/api/circuits",headers=b).json()==[]
        update=circuit_payload("Santa Cruz v2")
        upd=client.put(f"/api/circuits/{cid}",json=update,headers=a)
        assert upd.status_code==200,upd.text
        assert upd.json()["name"]=="Santa Cruz v2"
        assert len(upd.json()["sectors"])==2
        attempt=client.post("/api/attempts",headers=a,json={
          "circuit_id":cid,"elapsed_ms":167000,"sector_splits_ms":[50000,72000,45000],
          "gps_status":"review","confidence":0.84,"source_filename":"Bicicleta.gpx"
        })
        assert attempt.status_code==201,attempt.text
        assert len(client.get("/api/attempts",headers=a).json())==1
        assert client.get("/api/attempts",headers=b).json()==[]
        assert client.post("/api/attempts",headers=b,json={"circuit_id":cid,"sector_splits_ms":[100]}).status_code==404
        assert client.delete(f"/api/circuits/{cid}",headers=b).status_code==404
        assert client.delete(f"/api/circuits/{cid}",headers=a).status_code==204
        assert client.get(f"/api/circuits/{cid}",headers=a).status_code==404

def test_private_gpx_upload_download_delete():
    with TestClient(app) as client:
        a=pilot(client);b=pilot(client)
        xml=b'<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="36.70" lon="-4.4"/></trkseg></trk></gpx>'
        response=client.post("/api/activities",headers=a,files={"file":("santacruz.gpx",xml,"application/gpx+xml")},data={"gps_points":"25","distance_m":"1200"})
        assert response.status_code==201,response.text
        activity_id=response.json()["id"]
        assert len(client.get("/api/activities",headers=a).json())==1
        assert client.get("/api/activities",headers=b).json()==[]
        assert client.get(f"/api/activities/{activity_id}/file",headers=b).status_code==404
        download=client.get(f"/api/activities/{activity_id}/file",headers=a)
        assert download.status_code==200 and download.content==xml
        assert client.delete(f"/api/activities/{activity_id}",headers=b).status_code==404
        assert client.delete(f"/api/activities/{activity_id}",headers=a).status_code==204
        assert client.get(f"/api/activities/{activity_id}/file",headers=a).status_code==404

def test_no_auth_and_no_sensitive_files():
    with TestClient(app) as client:
        assert client.get("/api/health").json()["ok"] is True
        assert client.get("/api/circuits").status_code in (401,403)
        assert client.get("/editor.html").status_code==200
        for path in ("/backend/.env","/backend/app/models.py","/.git/config","/supabase/schema.sql"):
            assert client.get(path).status_code==404
