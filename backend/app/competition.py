"""Time trial: tournaments on a saved circuit between two dates, with automatic standings.

An organizer creates a tournament from one of the saved circuits; the circuit is then frozen.
Any rider uploads the GPX/TCX of a run. The server finds the run on the circuit and times it
with app.timing. A run that follows the circuit for at least the tournament's match share and
has no impossible stretch enters the standings at once; otherwise it is stored as rejected
with the reasons. An organizer can still accept or reject any entry by hand.
"""
import hashlib
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from . import config
from .database import get_db
from .models import Activity, Attempt, AttemptSplit, Circuit, Pilot, Tournament
from .ratelimit import RateLimit
from .schemas import ProfileIn, ReviewIn, TournamentIn
from .security import current_pilot, is_organizer, pilot_payload, require_organizer
from .timing import GpsError, detect_attempts, distance_series, parse_gps

router=APIRouter(prefix="/api")
entry_limit=RateLimit(30,3600)
UPLOAD_GRACE_DAYS=2  # riders may still upload runs this long after the last day

def utcnow()->datetime:
    return datetime.now(timezone.utc)

def local_date(db:Session,moment)->date:
    # Calendar days follow the competition's own time zone, computed by PostgreSQL.
    return db.scalar(select(func.date(func.timezone(config.COMPETITION_TIMEZONE,moment))))

def public_circuit(c:Circuit)->dict:
    """Circuit for maps and for the timing engine."""
    return {"id":str(c.id),"name":c.name,"points":c.reference_points,"gateRadius":c.gate_radius_m,
            "sectors":[{"index":s.gate_index,"name":s.name} for s in c.sectors],
            "weakZones":[{"from":z.start_index,"to":z.end_index,"name":z.name} for z in c.weak_zones],
            "length_m":round(distance_series(c.reference_points)[-1]),"in_tournament":c.published_at is not None}

def load_circuit(db:Session,circuit_id:uuid.UUID)->Circuit|None:
    return db.scalar(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
        .where(Circuit.id==circuit_id))

def tournament_state(t:Tournament,today:date)->str:
    return "proximo" if today<t.starts_on else "terminado" if today>t.ends_on else "activo"

def tournament_payload(t:Tournament,today:date,riders:int=0)->dict:
    return {"id":str(t.id),"name":t.name,"circuit_id":str(t.circuit_id),"circuit_name":t.circuit.name,
            "starts_on":t.starts_on.isoformat(),"ends_on":t.ends_on.isoformat(),"min_match":t.min_match,
            "state":tournament_state(t,today),"riders":riders}

def entry_payload(a:Attempt,pilot_name:str|None=None)->dict:
    return {"id":str(a.id),"tournament_id":str(a.tournament_id) if a.tournament_id else None,"pilot":pilot_name,
            "elapsed_ms":a.elapsed_ms,"sector_splits_ms":[s.elapsed_ms for s in a.splits],
            "started_at":a.started_at.isoformat() if a.started_at else None,
            "match":a.confidence,"gps_status":a.gps_status,"notes":a.notes,
            "review_status":a.review_status,"review_note":a.review_note,
            "source_filename":a.source_filename,"created_at":a.created_at.isoformat()}

def store_activity(db:Session,p:Pilot,filename:str,ext:str,data:bytes,fixes,digest:str,recorded_at)->Activity:
    """Keep the uploaded GPS file privately; the caller commits."""
    activity_id=uuid.uuid4()
    path=config.GPS_STORAGE_DIR/str(p.id)/f"{activity_id}.{ext}"
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(data)
    activity=Activity(id=activity_id,owner_id=p.id,filename=filename,storage_name=path.name,format=ext,
        file_bytes=len(data),gps_points=len(fixes),distance_m=distance_series(fixes)[-1],recorded_at=recorded_at,sha256=digest)
    db.add(activity)
    return activity

def remove_file(owner_id:uuid.UUID,storage_name:str):
    (config.GPS_STORAGE_DIR/str(owner_id)/storage_name).unlink(missing_ok=True)

async def read_gps_upload(file:UploadFile):
    filename=Path(file.filename or "bajada.gpx").name[:200]
    ext=filename.rsplit(".",1)[-1].lower()
    if ext not in ("gpx","tcx"):raise HTTPException(422,"Solo se admiten GPX o TCX")
    data=await file.read(config.MAX_UPLOAD_BYTES+1)
    if not data or len(data)>config.MAX_UPLOAD_BYTES:raise HTTPException(413,"Archivo vacío o superior a 20 MB")
    try:fixes=parse_gps(data,ext)
    except GpsError as exc:raise HTTPException(422,str(exc)) from exc
    return filename,ext,data,fixes,hashlib.sha256(data).hexdigest()

def run_attempt(p:Pilot,circuit_id,run,filename:str,activity_id,tournament_id=None)->Attempt:
    attempt=Attempt(pilot_id=p.id,circuit_id=circuit_id,activity_id=activity_id,tournament_id=tournament_id,
        source_filename=filename,started_at=datetime.fromtimestamp(run.started_ms/1000,timezone.utc),
        elapsed_ms=round(run.seconds*1000),confidence=run.confidence,
        gps_status="compatible" if run.status=="compatible" else "review",
        notes=" · ".join(run.issues+run.notes)[:500] or None,timed_by="server",profile=run.profile)
    attempt.splits=[AttemptSplit(sort_order=i,elapsed_ms=None if s is None else round(s*1000)) for i,s in enumerate(run.splits)]
    return attempt

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

@router.get("/public/circuits")
def circuit_catalog(db:Session=Depends(get_db)):
    """Every saved circuit: training finds them in any uploaded route."""
    circuits=db.scalars(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
        .order_by(Circuit.name).limit(500)).all()
    return [public_circuit(c) for c in circuits]

@router.post("/tournaments",status_code=201)
def create_tournament(payload:TournamentIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    c=load_circuit(db,payload.circuit_id)
    if not c:raise HTTPException(404,"Circuito no encontrado")
    # Standings compare splits between these exact gates: the circuit can no longer change.
    if c.published_at is None:c.published_at=utcnow()
    t=Tournament(name=payload.name,circuit_id=c.id,starts_on=payload.starts_on,ends_on=payload.ends_on,
                 min_match=payload.min_match,created_by=p.id)
    db.add(t);db.commit();db.refresh(t)
    return tournament_payload(t,local_date(db,func.now()))

@router.get("/public/tournaments")
def list_tournaments(db:Session=Depends(get_db)):
    today=local_date(db,func.now())
    counts=dict(db.execute(select(Attempt.tournament_id,func.count(func.distinct(Attempt.pilot_id)))
        .where(Attempt.tournament_id.is_not(None),Attempt.review_status=="approved").group_by(Attempt.tournament_id)).all())
    tournaments=db.scalars(select(Tournament).options(selectinload(Tournament.circuit)).limit(200)).all()
    order={"activo":0,"proximo":1,"terminado":2}
    def key(t:Tournament):
        # Running and upcoming by start date, finished ones latest first.
        state=tournament_state(t,today)
        return (order[state],-t.ends_on.toordinal() if state=="terminado" else t.starts_on.toordinal())
    return [tournament_payload(t,today,counts.get(t.id,0)) for t in sorted(tournaments,key=key)]

def get_tournament(db:Session,tournament_id:uuid.UUID)->Tournament:
    t=db.scalar(select(Tournament).options(selectinload(Tournament.circuit).selectinload(Circuit.sectors),
        selectinload(Tournament.circuit).selectinload(Circuit.weak_zones)).where(Tournament.id==tournament_id))
    if not t:raise HTTPException(404,"Torneo no encontrado")
    return t

@router.get("/public/tournaments/{tournament_id}")
def tournament_standings(tournament_id:uuid.UUID,db:Session=Depends(get_db)):
    t=get_tournament(db,tournament_id)
    best=db.execute(select(Attempt,Pilot.display_name,
            func.to_char(func.timezone(config.COMPETITION_TIMEZONE,Attempt.started_at),"YYYY-MM-DD"))
        .join(Pilot,Pilot.id==Attempt.pilot_id).options(selectinload(Attempt.splits))
        .where(Attempt.tournament_id==t.id,Attempt.review_status=="approved",Attempt.elapsed_ms.is_not(None))
        .order_by(Attempt.pilot_id,Attempt.elapsed_ms,Attempt.started_at)
        .distinct(Attempt.pilot_id)).all()
    best.sort(key=lambda row:(row[0].elapsed_ms,row[0].started_at))
    leader=best[0][0].elapsed_ms if best else None
    rows=[]
    for a,name,day in best:
        rank=1+sum(1 for other,_,_ in best if other.elapsed_ms<a.elapsed_ms)
        rows.append({"rank":rank,"entry_id":str(a.id),"pilot":name or "Piloto","elapsed_ms":a.elapsed_ms,
                     "gap_ms":a.elapsed_ms-leader,"sector_splits_ms":[s.elapsed_ms for s in a.splits],
                     "day":day,"match":a.confidence,"gps_status":a.gps_status})
    sectors=len(t.circuit.sectors)+1
    best_sectors=[min((r["sector_splits_ms"][i] for r in rows if r["sector_splits_ms"][i] is not None),default=None)
                  for i in range(sectors)]
    return {"tournament":tournament_payload(t,local_date(db,func.now()),len(rows)),"circuit":public_circuit(t.circuit),
            "rows":rows,"best_sectors_ms":best_sectors}

@router.delete("/tournaments/{tournament_id}",status_code=204)
def delete_tournament(tournament_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    t=get_tournament(db,tournament_id)
    if db.scalar(select(Attempt.id).where(Attempt.tournament_id==t.id).limit(1)):
        raise HTTPException(409,"El torneo ya tiene bajadas: no se puede borrar")
    circuit=t.circuit
    db.delete(t);db.flush()
    # A circuit no tournament uses any more can be edited or deleted again.
    if not db.scalar(select(Tournament.id).where(Tournament.circuit_id==circuit.id).limit(1)):
        circuit.published_at=None
    db.commit()

@router.post("/tournaments/{tournament_id}/entries",status_code=201)
async def submit_entry(tournament_id:uuid.UUID,file:UploadFile=File(...),db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    entry_limit.hit(str(p.id))
    if not p.display_name:
        raise HTTPException(409,"Elige primero tu nombre de piloto: es el que aparece en la clasificación")
    t=get_tournament(db,tournament_id)
    today=local_date(db,func.now())
    if today<t.starts_on:raise HTTPException(422,f"El torneo empieza el {t.starts_on:%d/%m/%Y}")
    if today>t.ends_on+timedelta(days=UPLOAD_GRACE_DAYS):raise HTTPException(422,f"El torneo terminó el {t.ends_on:%d/%m/%Y}")
    filename,ext,data,fixes,digest=await read_gps_upload(file)
    if db.scalar(select(Attempt.id).join(Activity,Activity.id==Attempt.activity_id)
            .where(Attempt.tournament_id==t.id,Activity.sha256==digest).limit(1)):
        raise HTTPException(409,"Este archivo GPS ya se ha presentado en este torneo")
    runs=[r for r in detect_attempts(fixes,public_circuit(t.circuit)) if r.seconds is not None]
    if not runs:
        raise HTTPException(422,f"No hay en el archivo una bajada completa y con hora de la salida a la meta de {t.circuit.name}")
    days={id(r):local_date(db,datetime.fromtimestamp(r.started_ms/1000,timezone.utc)) for r in runs}
    inside=[r for r in runs if t.starts_on<=days[id(r)]<=t.ends_on]
    if not inside:
        raise HTTPException(422,f"La bajada es del {days[id(runs[0])]:%d/%m/%Y} y el torneo va del "
                                f"{t.starts_on:%d/%m/%Y} al {t.ends_on:%d/%m/%Y}")
    passing=[r for r in inside if r.status=="compatible" and r.confidence>=t.min_match]
    run=min(passing or inside,key=lambda r:r.seconds)
    reasons=[]
    if run.confidence<t.min_match:
        reasons.append(f"coincide un {round(run.confidence*100)} % con el circuito (mínimo {round(t.min_match*100)} %)")
    if run.status!="compatible":reasons.extend(run.issues)
    activity=store_activity(db,p,filename,ext,data,fixes,digest,datetime.fromtimestamp(run.started_ms/1000,timezone.utc))
    entry=run_attempt(p,t.circuit_id,run,filename,activity.id,t.id)
    entry.review_status="approved" if passing else "rejected"
    entry.review_note="; ".join(reasons)[:300] or None
    entry.reviewed_at=utcnow()
    try:
        db.flush();db.add(entry);db.commit()
    except Exception:
        db.rollback();remove_file(p.id,activity.storage_name)
        raise
    return entry_payload(entry,p.display_name)

@router.get("/tournaments/{tournament_id}/entries/mine")
def my_entries(tournament_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    entries=db.scalars(select(Attempt).options(selectinload(Attempt.splits))
        .where(Attempt.tournament_id==tournament_id,Attempt.pilot_id==p.id).order_by(Attempt.created_at.desc())).all()
    return [entry_payload(a,p.display_name) for a in entries]

@router.get("/tournaments/{tournament_id}/entries")
def all_entries(tournament_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    require_organizer(p)
    rows=db.execute(select(Attempt,Pilot.display_name).join(Pilot,Pilot.id==Attempt.pilot_id)
        .options(selectinload(Attempt.splits)).where(Attempt.tournament_id==tournament_id)
        .order_by(Attempt.created_at.desc()).limit(500)).all()
    return [entry_payload(a,name) for a,name in rows]

@router.post("/entries/{entry_id}/review")
def review_entry(entry_id:uuid.UUID,payload:ReviewIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """The organizer's last word on an entry, whatever the automatic filter decided."""
    require_organizer(p)
    a=db.scalar(select(Attempt).where(Attempt.id==entry_id,Attempt.tournament_id.is_not(None)))
    if not a:raise HTTPException(404,"Bajada no encontrada")
    a.review_status=payload.decision
    a.review_note=(payload.note or "").strip() or None
    a.reviewed_at=utcnow()
    db.commit()
    return {"id":str(a.id),"review_status":a.review_status}

@router.get("/entries/{entry_id}/file")
def entry_file(entry_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    # The rider and the organizers can inspect the evidence of an entry.
    row=db.execute(select(Attempt,Activity).join(Activity,Activity.id==Attempt.activity_id)
        .where(Attempt.id==entry_id,Attempt.tournament_id.is_not(None))).first()
    if not row or (row[0].pilot_id!=p.id and not is_organizer(p)):raise HTTPException(404,"Bajada no encontrada")
    activity=row[1]
    path=config.GPS_STORAGE_DIR/str(activity.owner_id)/activity.storage_name
    if not path.is_file():raise HTTPException(404,"El archivo no está en el servidor")
    return FileResponse(path,filename=activity.filename,media_type="application/xml")
