"""Training: a rider uploads any route; the server finds every saved circuit ridden in it.

Each run found is timed like a time trial entry and kept privately with its profile
(position along the circuit and time of every reliable fix), so the rider can overlay
runs of the same circuit and compare speeds. Training runs never enter any standings.
The rider's own time trial entries are listed too, so they can be compared with training,
and so are the runs of accepted friends (only runs on circuits, never their whole routes).
"""
import math
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session, selectinload

from . import config
from .competition import public_circuit, read_gps_upload, remove_file, run_attempt, store_activity
from .database import SessionLocal, get_db
from .friends import friend_ids
from .models import Activity, Attempt, Circuit, Pilot, Tournament
from .ratelimit import RateLimit
from .security import current_pilot
from .timing import GpsError, detect_attempts, haversine, parse_gps

router=APIRouter(prefix="/api/training")
route_limit=RateLimit(60,3600)
NEAR_ROUTE_M=200  # a circuit is only searched when its start lies this close to the route's area

def training_runs():
    return select(Attempt).where(Attempt.tournament_id.is_(None),Attempt.timed_by=="server",Attempt.review_status.is_(None))

def tournament_evidence():
    """Files that prove a time trial entry."""
    return select(Attempt.activity_id).where(Attempt.tournament_id.is_not(None),Attempt.activity_id.is_not(None))

def comparable_runs(pilot_ids):
    """Training runs and time trial entries of these riders, with circuit, tournament and rider names."""
    kinds=(Attempt.timed_by=="server")&(((Attempt.tournament_id.is_(None))&(Attempt.review_status.is_(None)))
                                         |(Attempt.tournament_id.is_not(None)))
    return (select(Attempt,Circuit.name,Tournament.name,Pilot.display_name).join(Circuit,Circuit.id==Attempt.circuit_id)
            .join(Pilot,Pilot.id==Attempt.pilot_id)
            .outerjoin(Tournament,Tournament.id==Attempt.tournament_id).options(selectinload(Attempt.splits))
            .where(Attempt.pilot_id.in_(list(pilot_ids)),kinds))

def run_payload(a:Attempt,circuit_name:str,with_profile=False,tournament_name:str|None=None,
                pilot_name:str|None=None,mine:bool=True)->dict:
    payload={"id":str(a.id),"circuit_id":str(a.circuit_id),"circuit_name":circuit_name,
             "tournament_name":tournament_name,"review_status":a.review_status,
             "pilot":pilot_name or "Piloto","mine":mine,
             # A friend sees the run, not which file or route it came from.
             "activity_id":str(a.activity_id) if a.activity_id and mine else None,
             "source_filename":a.source_filename if mine else None,
             "started_at":a.started_at.isoformat() if a.started_at else None,"elapsed_ms":a.elapsed_ms,
             "sector_splits_ms":[s.elapsed_ms for s in a.splits],"match":a.confidence,
             "gps_status":a.gps_status,"notes":a.notes}
    if with_profile:payload["profile"]=a.profile or []
    return payload

def near_route(fixes,circuit:dict)->bool:
    lats=[f.lat for f in fixes];lons=[f.lon for f in fixes]
    start=circuit["points"][0]
    # Cheap box test first, then the real distance to the closest fix.
    margin=NEAR_ROUTE_M/111195
    if not (min(lats)-margin<=start[0]<=max(lats)+margin and min(lons)-2*margin<=start[1]<=max(lons)+2*margin):
        return False
    return any(haversine(f,start)<=NEAR_ROUTE_M for f in fixes)

def nearest_circuit(fixes,circuits:list[dict])->dict|None:
    """The circuit whose line the route comes closest to, for a route where no run was found."""
    sample=fixes[::3] or fixes
    best=None
    for c in circuits:
        ref=c["points"]
        kx,ky=111195*math.cos(math.radians(ref[0][0])),111195
        metres=min(math.hypot((f.lon-p[1])*kx,(f.lat-p[0])*ky) for f in sample for p in ref)
        if best is None or metres<best["distance_m"]:best={"circuit_name":c["name"],"distance_m":round(metres)}
    if best:best["passes"]=best["distance_m"]<=30  # rides on it, but not from start to finish
    return best

def scan_routes_for_circuit(circuit_id:uuid.UUID)->int:
    """Look for a saved or changed circuit in every training route already uploaded.

    Runs earlier on a circuit's old line are dropped first; time trial entries are never touched.
    Runs after the response, in its own database session.
    """
    with SessionLocal() as db:
        c=db.scalar(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))
                    .where(Circuit.id==circuit_id))
        if not c:return 0
        circuit=public_circuit(c)
        db.execute(delete(Attempt).where(Attempt.circuit_id==c.id,Attempt.tournament_id.is_(None),
                                         Attempt.timed_by=="server",Attempt.review_status.is_(None)))
        found=0
        for a in db.scalars(select(Activity).where(Activity.id.not_in(tournament_evidence()))).all():
            try:fixes=parse_gps((config.GPS_STORAGE_DIR/str(a.owner_id)/a.storage_name).read_bytes(),a.format)
            except (OSError,GpsError):continue
            if not near_route(fixes,circuit):continue
            owner=db.get(Pilot,a.owner_id)
            for run in detect_attempts(fixes,circuit):
                if run.seconds is None:continue
                db.add(run_attempt(owner,c.id,run,a.filename,a.id))
                found+=1
        db.commit()
        return found

@router.post("/routes",status_code=201)
async def upload_route(file:UploadFile=File(...),db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    route_limit.hit(str(p.id))
    filename,ext,data,fixes,digest=await read_gps_upload(file)
    # A file sent to a time trial is welcome here: only earlier training uploads are repeats.
    repeated=db.execute(select(Activity.filename,func.to_char(func.timezone(config.COMPETITION_TIMEZONE,Activity.recorded_at),
                                                              "DD/MM/YYYY HH24:MI"))
        .where(Activity.owner_id==p.id,Activity.sha256==digest,Activity.id.not_in(tournament_evidence())).limit(1)).first()
    if repeated:
        when=f", salida del {repeated[1]}" if repeated[1] else ""
        raise HTTPException(409,f"Ya habías subido esta ruta a entrenamiento: «{repeated[0]}»{when}")
    circuits=db.scalars(select(Circuit).options(selectinload(Circuit.sectors),selectinload(Circuit.weak_zones))).all()
    found=[]
    for c in circuits:
        data_c=public_circuit(c)
        if not near_route(fixes,data_c):continue
        runs=[r for r in detect_attempts(fixes,data_c) if r.seconds is not None]
        if runs:found.append((c,runs))
    recorded=next((f.time for f in fixes if f.time is not None),None)
    activity=store_activity(db,p,filename,ext,data,fixes,digest,
                            datetime.fromtimestamp(recorded/1000,timezone.utc) if recorded else None)
    attempts=[]
    try:
        db.flush()
        for c,runs in found:
            for run in runs:
                attempt=run_attempt(p,c.id,run,filename,activity.id)
                db.add(attempt);attempts.append((attempt,c.name))
        db.commit()
    except Exception:
        db.rollback();remove_file(p.id,activity.storage_name)
        raise
    return {"activity":{"id":str(activity.id),"filename":activity.filename,"distance_m":activity.distance_m},
            "found":[{"circuit_id":str(c.id),"circuit_name":c.name,"runs":len(runs)} for c,runs in found],
            "nearest":None if found else nearest_circuit(fixes,[public_circuit(c) for c in circuits]),
            "runs":[run_payload(a,name) for a,name in attempts]}

@router.get("/routes")
def my_routes(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Uploaded training routes with how many runs were found in each (time trial files are not listed)."""
    entries=tournament_evidence()
    counts=dict(db.execute(training_runs().with_only_columns(Attempt.activity_id,func.count())
        .where(Attempt.pilot_id==p.id).group_by(Attempt.activity_id)).all())
    activities=db.scalars(select(Activity).where(Activity.owner_id==p.id,Activity.id.not_in(entries))
        .order_by(Activity.created_at.desc()).limit(200)).all()
    return [{"id":str(a.id),"filename":a.filename,"distance_m":a.distance_m,
             "recorded_at":a.recorded_at.isoformat() if a.recorded_at else None,
             "created_at":a.created_at.isoformat(),"runs":counts.get(a.id,0)} for a in activities]

@router.delete("/routes/{activity_id}",status_code=204)
def delete_route(activity_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    a=db.scalar(select(Activity).where(Activity.id==activity_id,Activity.owner_id==p.id))
    if not a:raise HTTPException(404,"Ruta no encontrada")
    if db.scalar(select(Attempt.id).where(Attempt.activity_id==a.id,Attempt.tournament_id.is_not(None)).limit(1)):
        raise HTTPException(409,"Este GPS es una bajada presentada a un torneo y no se puede borrar")
    db.execute(delete(Attempt).where(Attempt.activity_id==a.id,Attempt.tournament_id.is_(None)))
    storage=a.storage_name
    db.delete(a);db.commit()
    remove_file(p.id,storage)

@router.get("/runs")
def my_runs(circuit_id:uuid.UUID|None=None,friends:bool=False,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    owners=[p.id,*(friend_ids(db,p.id) if friends else [])]
    q=comparable_runs(owners)
    if circuit_id:q=q.where(Attempt.circuit_id==circuit_id)
    rows=db.execute(q.order_by(Attempt.started_at.desc()).limit(1000)).all()
    # The same run uploaded both to a time trial and to training is listed once, as the entry.
    key=lambda a:(a.pilot_id,a.circuit_id,round(a.started_at.timestamp()))
    entered={key(a) for a,_,t,_ in rows if t and a.started_at}
    return [run_payload(a,name,tournament_name=t,pilot_name=pilot,mine=a.pilot_id==p.id) for a,name,t,pilot in rows
            if t or not a.started_at or key(a) not in entered]

@router.get("/runs/{run_id}")
def one_run(run_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    row=db.execute(comparable_runs([p.id,*friend_ids(db,p.id)]).where(Attempt.id==run_id)).first()
    if not row:raise HTTPException(404,"Bajada no encontrada")
    a,name,tournament,pilot=row
    return run_payload(a,name,with_profile=True,tournament_name=tournament,pilot_name=pilot,mine=a.pilot_id==p.id)
