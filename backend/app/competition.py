"""Monthly competition: published circuits, server-timed entries, organizer review, public standings.

A rider uploads the GPX/TCX of a run. The server finds the run on the circuit,
times it with app.timing and stores it as a pending entry. Only entries an
organizer approves enter the ranking: the best approved time per rider and month.
"""
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import config
from .database import get_db
from .models import Activity, Attempt, AttemptSplit, Circuit, Pilot
from .ratelimit import RateLimit
from .schemas import ProfileIn, ReviewIn
from .security import current_pilot, pilot_payload, require_organizer
from .timing import GpsError, best_attempt, detect_attempts, distance_series, parse_gps

router=APIRouter(prefix="/api")
entry_limit=RateLimit(30,3600)
_MONTH=re.compile(r"\d{4}-(0[1-9]|1[0-2])")

def utcnow()->datetime:
    return datetime.now(timezone.utc)

def local_text(column,pattern:str):
    # Months and days follow the competition's own time zone, computed by PostgreSQL.
    return func.to_char(func.timezone(config.COMPETITION_TIMEZONE,column),pattern)

def public_circuit(c:Circuit)->dict:
    """Editor-compatible circuit; also the input of the timing engine."""
    return {"id":str(c.id),"name":c.name,"points":c.reference_points,"gateRadius":c.gate_radius_m,
            "sectors":[{"index":s.gate_index,"name":s.name} for s in c.sectors],
            "weakZones":[{"from":z.start_index,"to":z.end_index,"name":z.name} for z in c.weak_zones],
            "published_at":c.published_at.isoformat() if c.published_at else None}

def published_circuit(db:Session,circuit_id:uuid.UUID)->Circuit:
    c=db.scalar(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
        .where(Circuit.id==circuit_id,Circuit.published_at.is_not(None)))
    if not c:raise HTTPException(404,"Circuito no publicado en la competición")
    return c

def entry_payload(a:Attempt,circuit_name:str,pilot_name:str|None=None)->dict:
    return {"id":str(a.id),"circuit_id":str(a.circuit_id),"circuit_name":circuit_name,"pilot":pilot_name,
            "elapsed_ms":a.elapsed_ms,"sector_splits_ms":[s.elapsed_ms for s in a.splits],
            "started_at":a.started_at.isoformat() if a.started_at else None,
            "gps_status":a.gps_status,"confidence":a.confidence,"issues":a.notes,
            "review_status":a.review_status,"review_note":a.review_note,
            "source_filename":a.source_filename,"created_at":a.created_at.isoformat()}

@router.put("/me/profile")
def set_profile(payload:ProfileIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    taken=db.scalar(select(Pilot.id).where(func.lower(Pilot.display_name)==payload.display_name.lower(),Pilot.id!=p.id))
    if taken:raise HTTPException(409,"Ese nombre de piloto ya está en uso")
    p.display_name=payload.display_name
    try:db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409,"Ese nombre de piloto ya está en uso")
    return pilot_payload(p)

@router.post("/circuits/{circuit_id}/publish")
def publish_circuit(circuit_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    c=db.scalar(select(Circuit).where(Circuit.id==circuit_id,Circuit.owner_id==p.id))
    if not c:raise HTTPException(404,"Circuito no encontrado")
    if c.published_at is None:
        c.published_at=utcnow()
        db.commit()
    return {"id":str(c.id),"published_at":c.published_at.isoformat()}

@router.get("/public/circuits")
def public_circuits(db:Session=Depends(get_db)):
    circuits=db.scalars(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
        .where(Circuit.published_at.is_not(None)).order_by(Circuit.published_at.desc()).limit(100)).all()
    return [public_circuit(c) for c in circuits]

@router.get("/public/circuits/{circuit_id}/leaderboard")
def leaderboard(circuit_id:uuid.UUID,month:str|None=None,db:Session=Depends(get_db)):
    c=published_circuit(db,circuit_id)
    current=db.scalar(select(local_text(func.now(),"YYYY-MM")))
    month=month or current
    if not _MONTH.fullmatch(month):raise HTTPException(422,"Mes no válido: usa AAAA-MM")
    ranked=(Attempt.circuit_id==c.id,Attempt.review_status=="approved",Attempt.timed_by=="server",
            Attempt.elapsed_ms.is_not(None))
    best=db.execute(select(Attempt,Pilot.display_name,local_text(Attempt.started_at,"YYYY-MM-DD"))
        .join(Pilot,Pilot.id==Attempt.pilot_id).options(selectinload(Attempt.splits))
        .where(*ranked,local_text(Attempt.started_at,"YYYY-MM")==month)
        .order_by(Attempt.pilot_id,Attempt.elapsed_ms,Attempt.started_at)
        .distinct(Attempt.pilot_id)).all()
    best.sort(key=lambda row:(row[0].elapsed_ms,row[0].started_at))
    leader=best[0][0].elapsed_ms if best else None
    rows=[]
    for a,name,day in best:
        rank=1+sum(1 for other,_,_ in best if other.elapsed_ms<a.elapsed_ms)
        rows.append({"rank":rank,"entry_id":str(a.id),"pilot":name or "Piloto","elapsed_ms":a.elapsed_ms,
                     "gap_ms":a.elapsed_ms-leader,"sector_splits_ms":[s.elapsed_ms for s in a.splits],
                     "day":day,"gps_status":a.gps_status})
    sectors=len(c.sectors)+1
    best_sectors=[min((r["sector_splits_ms"][i] for r in rows if r["sector_splits_ms"][i] is not None),default=None)
                  for i in range(sectors)]
    months=db.scalars(select(local_text(Attempt.started_at,"YYYY-MM")).where(*ranked).distinct()).all()
    return {"circuit":public_circuit(c),"month":month,"current_month":current,
            "months":sorted(set(months)|{current},reverse=True),"rows":rows,"best_sectors_ms":best_sectors}

@router.post("/competition/entries",status_code=201)
async def submit_entry(circuit_id:uuid.UUID=Form(...),file:UploadFile=File(...),
    db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    entry_limit.hit(str(p.id))
    if not p.display_name:
        raise HTTPException(409,"Elige primero tu nombre de piloto: es el que aparece en la clasificación")
    c=published_circuit(db,circuit_id)
    filename=Path(file.filename or "bajada.gpx").name[:200]
    ext=filename.rsplit(".",1)[-1].lower()
    if ext not in ("gpx","tcx"):raise HTTPException(422,"Solo se admiten GPX o TCX")
    data=await file.read(config.MAX_UPLOAD_BYTES+1)
    if not data or len(data)>config.MAX_UPLOAD_BYTES:raise HTTPException(413,"Archivo vacío o superior a 20 MB")
    digest=hashlib.sha256(data).hexdigest()
    if db.scalar(select(Attempt.id).join(Activity,Activity.id==Attempt.activity_id)
            .where(Attempt.circuit_id==c.id,Attempt.review_status.is_not(None),Activity.sha256==digest).limit(1)):
        raise HTTPException(409,"Este archivo GPS ya se ha presentado en este circuito")
    try:fixes=parse_gps(data,ext)
    except GpsError as exc:raise HTTPException(422,str(exc)) from exc
    run=best_attempt(detect_attempts(fixes,public_circuit(c)))
    if run is None:
        raise HTTPException(422,"No hay en el archivo una bajada completa y con marcas de tiempo de la salida a la meta de este circuito")
    started=datetime.fromtimestamp(run.started_ms/1000,timezone.utc)
    now=utcnow()
    if started>now+timedelta(minutes=10):raise HTTPException(422,"La bajada tiene una fecha futura")
    if now-started>timedelta(days=config.ENTRY_MAX_AGE_DAYS):
        raise HTTPException(422,f"Solo se aceptan bajadas de los últimos {config.ENTRY_MAX_AGE_DAYS} días")
    activity_id=uuid.uuid4()
    path=config.GPS_STORAGE_DIR/str(p.id)/f"{activity_id}.{ext}"
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(data)
    activity=Activity(id=activity_id,owner_id=p.id,filename=filename,storage_name=path.name,format=ext,
        file_bytes=len(data),gps_points=len(fixes),distance_m=distance_series(fixes)[-1],recorded_at=started,sha256=digest)
    entry=Attempt(pilot_id=p.id,circuit_id=c.id,activity_id=activity_id,source_filename=filename,started_at=started,
        elapsed_ms=round(run.seconds*1000),confidence=run.confidence,
        gps_status="compatible" if run.status=="compatible" else "review",
        notes=" · ".join(run.issues + run.notes)[:500] or None,timed_by="server",review_status="pending")
    entry.splits=[AttemptSplit(sort_order=i,elapsed_ms=None if s is None else round(s*1000)) for i,s in enumerate(run.splits)]
    try:
        db.add(activity);db.flush();db.add(entry);db.commit()
    except Exception:
        db.rollback();path.unlink(missing_ok=True)
        raise
    return entry_payload(entry,c.name,p.display_name)

@router.get("/competition/entries")
def my_entries(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    rows=db.execute(select(Attempt,Circuit.name).join(Circuit,Circuit.id==Attempt.circuit_id)
        .options(selectinload(Attempt.splits))
        .where(Attempt.pilot_id==p.id,Attempt.review_status.is_not(None))
        .order_by(Attempt.created_at.desc()).limit(100)).all()
    return [entry_payload(a,name,p.display_name) for a,name in rows]

@router.get("/competition/review")
def review_queue(status:Literal["pending","approved","rejected"]="pending",
    db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    rows=db.execute(select(Attempt,Circuit.name,Pilot.display_name)
        .join(Circuit,Circuit.id==Attempt.circuit_id).join(Pilot,Pilot.id==Attempt.pilot_id)
        .options(selectinload(Attempt.splits))
        .where(Circuit.owner_id==p.id,Attempt.review_status==status)
        .order_by(Attempt.created_at).limit(200)).all()
    return [entry_payload(a,circuit,pilot) for a,circuit,pilot in rows]

def entry_for_organizer(db:Session,entry_id:uuid.UUID,p:Pilot)->Attempt:
    a=db.scalar(select(Attempt).join(Circuit,Circuit.id==Attempt.circuit_id)
        .where(Attempt.id==entry_id,Circuit.owner_id==p.id,Attempt.review_status.is_not(None)))
    if not a:raise HTTPException(404,"Participación no encontrada")
    return a

@router.post("/competition/entries/{entry_id}/review")
def review_entry(entry_id:uuid.UUID,payload:ReviewIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    a=entry_for_organizer(db,entry_id,p)
    a.review_status=payload.decision
    a.review_note=(payload.note or "").strip() or None
    a.reviewed_at=utcnow()
    db.commit()
    return {"id":str(a.id),"review_status":a.review_status}

@router.get("/competition/entries/{entry_id}/file")
def entry_file(entry_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    # The rider and the circuit's organizer can inspect the evidence of an entry.
    row=db.execute(select(Attempt,Activity,Circuit.owner_id)
        .join(Activity,Activity.id==Attempt.activity_id).join(Circuit,Circuit.id==Attempt.circuit_id)
        .where(Attempt.id==entry_id,Attempt.review_status.is_not(None))).first()
    if not row or p.id not in (row[0].pilot_id,row[2]):raise HTTPException(404,"Participación no encontrada")
    activity=row[1]
    path=config.GPS_STORAGE_DIR/str(activity.owner_id)/activity.storage_name
    if not path.is_file():raise HTTPException(404,"El archivo no está en el servidor")
    return FileResponse(path,filename=activity.filename,media_type="application/xml")
