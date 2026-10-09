"""DH Trails Local — local FastAPI server + PostgreSQL.

Run from backend/: python run.py
API docs: http://127.0.0.1:8000/docs
"""
import uuid
from datetime import datetime
from pathlib import Path

from defusedxml.ElementTree import fromstring as safe_xml
from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from .config import CORS_ORIGINS, GPS_STORAGE_DIR, MAX_UPLOAD_BYTES, REPO_ROOT, require_secret
from .database import get_db
from .models import Activity, Attempt, AttemptSplit, Circuit, Pilot, Sector, WeakZone
from .schemas import AttemptIn, CircuitIn, Credentials
from .security import current_pilot, issue_token, password_hash, verify_password

app=FastAPI(title="DH Trails Local API",version="0.4.0",description="Private GPS training API; no official time certification")
app.add_middleware(CORSMiddleware,allow_origins=CORS_ORIGINS,allow_methods=["GET","POST","PUT","DELETE"],allow_headers=["Authorization","Content-Type"])

@app.on_event("startup")
def validate_settings():
    require_secret()

@app.get("/api/health")
def health(db:Session=Depends(get_db)):
    db.execute(text("SELECT 1"))
    return {"ok":True,"service":"dhtrailslocal-fastapi","database":"postgresql"}

def user_payload(p:Pilot):
    return {"id":str(p.id),"email":p.email}

@app.post("/api/auth/register",status_code=201)
def register(credentials:Credentials,db:Session=Depends(get_db)):
    email=str(credentials.email).strip().lower()
    if db.scalar(select(Pilot.id).where(Pilot.email==email)):
        raise HTTPException(409,"El correo ya está registrado")
    p=Pilot(email=email,password_hash=password_hash(credentials.password))
    db.add(p)
    try: db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409,"El correo ya está registrado")
    db.refresh(p)
    return {"access_token":issue_token(p.id),"user":user_payload(p)}

@app.post("/api/auth/login")
def login(credentials:Credentials,db:Session=Depends(get_db)):
    p=db.scalar(select(Pilot).where(Pilot.email==str(credentials.email).strip().lower()))
    if not p or not verify_password(credentials.password,p.password_hash):
        raise HTTPException(401,"Credenciales incorrectas")
    return {"access_token":issue_token(p.id),"user":user_payload(p)}

@app.get("/api/auth/me")
def whoami(p:Pilot=Depends(current_pilot)):
    return user_payload(p)

def circuit_payload(c:Circuit):
    return {
        "id":str(c.id),"cloud_id":str(c.id),"version":2,"name":c.name,
        "points":c.reference_points,"gateRadius":c.gate_radius_m,
        "createdAt":c.created_at.isoformat(),
        "sectors":[{"index":s.gate_index,"name":s.name} for s in c.sectors],
        "weakZones":[{"from":z.start_index,"to":z.end_index,"name":z.name} for z in c.weak_zones]
    }

def circuit_for_user(db:Session,circuit_id:uuid.UUID,user_id:uuid.UUID)->Circuit:
    c=db.scalar(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
       .where(Circuit.id==circuit_id,Circuit.owner_id==user_id))
    if not c:raise HTTPException(404,"Circuito no encontrado")
    return c

def assign_circuit(c:Circuit,payload:CircuitIn):
    c.name=payload.name.strip()
    c.reference_points=payload.points
    c.gate_radius_m=payload.gateRadius
    c.sectors=[Sector(sort_order=i,gate_index=s.index,name=s.name.strip()) for i,s in enumerate(payload.sectors)]
    c.weak_zones=[WeakZone(start_index=z.from_index,end_index=z.to,name=z.name.strip()) for z in payload.weakZones]

@app.get("/api/circuits")
def list_circuits(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    circuits=db.scalars(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
        .where(Circuit.owner_id==p.id).order_by(Circuit.updated_at.desc()).limit(250)).all()
    return [circuit_payload(c) for c in circuits]

@app.post("/api/circuits",status_code=201)
def create_circuit(payload:CircuitIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=Circuit(owner_id=p.id,name=payload.name.strip(),reference_points=[])
    assign_circuit(c,payload)
    db.add(c)
    db.commit()
    db.refresh(c)
    return circuit_payload(c)

@app.get("/api/circuits/{circuit_id}")
def get_circuit(circuit_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    return circuit_payload(circuit_for_user(db,circuit_id,p.id))

@app.put("/api/circuits/{circuit_id}")
def update_circuit(circuit_id:uuid.UUID,payload:CircuitIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=circuit_for_user(db,circuit_id,p.id)
    assign_circuit(c,payload)
    db.commit()
    return circuit_payload(circuit_for_user(db,circuit_id,p.id))

@app.delete("/api/circuits/{circuit_id}",status_code=204)
def delete_circuit(circuit_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=circuit_for_user(db,circuit_id,p.id)
    db.delete(c)
    db.commit()
    return Response(status_code=204)

@app.post("/api/attempts",status_code=201)
def create_attempt(payload:AttemptIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=circuit_for_user(db,payload.circuit_id,p.id)
    if payload.activity_id and not db.scalar(select(Activity.id).where(Activity.id==payload.activity_id,Activity.owner_id==p.id)):
        raise HTTPException(404,"Actividad GPS no encontrada")
    if len(payload.sector_splits_ms)!=len(c.sectors)+1:
        raise HTTPException(422,"El número de parciales no coincide con los sectores del circuito")
    a=Attempt(pilot_id=p.id,circuit_id=c.id,activity_id=payload.activity_id,
        source_filename=payload.source_filename,started_at=payload.started_at,elapsed_ms=payload.elapsed_ms,
        confidence=payload.confidence,gps_status=payload.gps_status,notes=payload.notes)
    a.splits=[AttemptSplit(sort_order=i,elapsed_ms=ms) for i,ms in enumerate(payload.sector_splits_ms)]
    db.add(a);db.commit();db.refresh(a)
    return {"id":str(a.id),"gps_status":a.gps_status}

@app.get("/api/attempts")
def list_attempts(circuit_id:uuid.UUID|None=None,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    q=select(Attempt).options(selectinload(Attempt.splits)).where(Attempt.pilot_id==p.id)
    if circuit_id:q=q.where(Attempt.circuit_id==circuit_id)
    attempts=db.scalars(q.order_by(Attempt.created_at.desc()).limit(200)).all()
    return [{"id":str(a.id),"circuit_id":str(a.circuit_id),"elapsed_ms":a.elapsed_ms,
      "sector_splits_ms":[s.elapsed_ms for s in a.splits],"gps_status":a.gps_status,
      "source_filename":a.source_filename,"created_at":a.created_at.isoformat()}
      for a in attempts]

def activity_payload(a:Activity):
    return {"id":str(a.id),"filename":a.filename,"format":a.format,
            "gps_points":a.gps_points,"distance_m":a.distance_m,"created_at":a.created_at.isoformat()}

@app.post("/api/activities",status_code=201)
async def upload_activity(file:UploadFile=File(...),gps_points:int|None=Form(None),distance_m:float|None=Form(None),
    db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    filename=Path(file.filename or "activity.gpx").name[:200]
    ext=filename.rsplit(".",1)[-1].lower()
    if ext not in ("gpx","tcx"):raise HTTPException(422,"Solo se admiten GPX o TCX")
    data=await file.read(MAX_UPLOAD_BYTES+1)
    if not data or len(data)>MAX_UPLOAD_BYTES:raise HTTPException(413,"Archivo vacío o superior a 20 MB")
    try:
        root=safe_xml(data)
        root_name=root.tag.rsplit("}",1)[-1].lower()
        if root_name not in ("gpx","trainingcenterdatabase"):
            raise ValueError("El formato XML no coincide con GPX/TCX")
        if ext=="gpx" and root_name!="gpx" or ext=="tcx" and root_name!="trainingcenterdatabase":
            raise ValueError("Extensión y tipo de XML no coinciden")
    except Exception as exc:
        raise HTTPException(422,"Archivo GPS XML no válido") from exc
    if gps_points is not None and not 2<=gps_points<=80000:raise HTTPException(422,"Número de puntos fuera de rango")
    if distance_m is not None and not 0<=distance_m<=10000000:raise HTTPException(422,"Distancia fuera de rango")
    activity_id=uuid.uuid4()
    safe_name=f"{activity_id}.{ext}"
    path=GPS_STORAGE_DIR/str(p.id)/safe_name
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(data)
    a=Activity(id=activity_id,owner_id=p.id,filename=filename,storage_name=safe_name,
        format=ext,file_bytes=len(data),gps_points=gps_points,distance_m=distance_m)
    try:
        db.add(a);db.commit();db.refresh(a)
    except Exception:
        db.rollback();path.unlink(missing_ok=True)
        raise
    return activity_payload(a)

@app.get("/api/activities")
def list_activities(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    return [activity_payload(a) for a in db.scalars(select(Activity)
        .where(Activity.owner_id==p.id).order_by(Activity.created_at.desc()).limit(100)).all()]

def activity_for_user(db:Session,id:uuid.UUID,p:Pilot):
    a=db.scalar(select(Activity).where(Activity.id==id,Activity.owner_id==p.id))
    if not a:raise HTTPException(404,"Actividad no encontrada")
    return a

@app.get("/api/activities/{activity_id}/file")
def download_activity(activity_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    a=activity_for_user(db,activity_id,p)
    path=GPS_STORAGE_DIR/str(a.owner_id)/a.storage_name
    if not path.is_file():raise HTTPException(404,"El archivo no está en el servidor")
    return FileResponse(path,filename=a.filename,media_type="application/xml")

@app.delete("/api/activities/{activity_id}",status_code=204)
def delete_activity(activity_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    a=activity_for_user(db,activity_id,p)
    path=GPS_STORAGE_DIR/str(a.owner_id)/a.storage_name
    db.delete(a);db.commit()
    path.unlink(missing_ok=True)
    return Response(status_code=204)

# Serve ONLY the public frontend files. Never mount the repository root:
# that would expose backend/.env, database passwords, uploads and Git metadata.
_PUBLIC_FILES={"index.html","editor.html","editor.css","editor.mjs","gps-engine.mjs","api-client.mjs"}
@app.get("/",include_in_schema=False)
def home():
    return FileResponse(REPO_ROOT/"index.html")

@app.get("/{asset_name}",include_in_schema=False)
def frontend_asset(asset_name:str):
    if asset_name not in _PUBLIC_FILES:
        raise HTTPException(404,"Recurso no encontrado")
    return FileResponse(REPO_ROOT/asset_name)
