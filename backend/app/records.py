"""Circuit records: every rider's best run on each circuit, and who holds the hot seat (the best of all).

Every run found on a circuit counts: training runs found in uploaded routes and accepted time trial
entries. Training runs go through the same checks as time trial entries (app.integrity): one that looks
edited or copied does not count. Like in a time trial, only the organization sees why; the rider sees
that it does not count. A rider may choose not to appear in the records.
"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.orm import Session, selectinload

from . import config
from .competition import ensure_checks, load_circuit, public_circuit
from .database import get_db
from .friends import friend_ids
from .models import Attempt, AttemptSplit, Circuit, Pilot
from .schemas import RecordsIn
from .security import current_pilot, is_organizer

router=APIRouter(prefix="/api/records")

def training():
    return (Attempt.tournament_id.is_(None))&(Attempt.review_status.is_(None))&(Attempt.timed_by=="server")

def counted():
    """Runs in the records: training runs without signs of an edited or copied file (or not checked
    yet: they are checked before they show) and accepted time trial entries, of riders who appear."""
    clean=Attempt.checks.is_(None)|(Attempt.checks==[])
    entry=(Attempt.tournament_id.is_not(None))&(Attempt.review_status=="approved")&(Attempt.timed_by=="server")
    return (Attempt.elapsed_ms.is_not(None))&((training()&clean)|entry)&(Pilot.in_records.is_(True))

def day():
    return func.to_char(func.timezone(config.COMPETITION_TIMEZONE,Attempt.started_at),"YYYY-MM-DD")

def checked(db:Session,query)->list:
    """The rows of a query of runs (the run first) once every training run in them has been checked.
    A run that turns out to look edited leaves the query, and the next one takes its place."""
    while True:
        rows=db.execute(query).all()
        todo=[row[0] for row in rows if row[0].checks is None and row[0].tournament_id is None]
        if not todo:return rows
        ensure_checks(db,todo)

def best_runs(db:Session,circuit_ids=None,pilot_ids=None)->list:
    """Each rider's best run on each circuit: (run, rider's name, day)."""
    q=(select(Attempt,Pilot.display_name,day()).join(Pilot,Pilot.id==Attempt.pilot_id)
       .options(selectinload(Attempt.splits)).where(counted())
       # The same ride sent to a time trial and to training: the time trial entry.
       .order_by(Attempt.circuit_id,Attempt.pilot_id,Attempt.elapsed_ms,Attempt.started_at,Attempt.tournament_id.is_(None))
       .ext(distinct_on(Attempt.circuit_id,Attempt.pilot_id)))
    if circuit_ids is not None:q=q.where(Attempt.circuit_id.in_(list(circuit_ids)))
    if pilot_ids is not None:q=q.where(Attempt.pilot_id.in_(list(pilot_ids)))
    return checked(db,q)

def table(rows:list,p:Pilot,runs:dict|None=None)->list[dict]:
    """A circuit's best runs in order: the first one holds the hot seat (on a tie, who set it first)."""
    rows=sorted(rows,key=lambda row:(row[0].elapsed_ms,row[0].started_at))
    first=rows[0][0].elapsed_ms if rows else 0
    return [{"rank":1+sum(1 for other,_,_ in rows if other.elapsed_ms<a.elapsed_ms),"pilot":name or "Piloto",
             "mine":a.pilot_id==p.id,"elapsed_ms":a.elapsed_ms,"gap_ms":a.elapsed_ms-first,"day":when,
             "runs":(runs or {}).get(a.pilot_id,1),"tournament":a.tournament_id is not None,
             "sector_splits_ms":[s.elapsed_ms for s in a.splits]} for a,name,when in rows]

def riders(db:Session,p:Pilot,friends:bool):
    """Everyone, or only me and my friends."""
    return [p.id,*friend_ids(db,p.id)] if friends else None

@router.get("")
def records(friends:bool=False,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Every circuit with who holds its hot seat, how many riders have a time on it and where I am."""
    boards={}
    for row in best_runs(db,pilot_ids=riders(db,p,friends)):boards.setdefault(row[0].circuit_id,[]).append(row)
    circuits=[]
    for cid,name,approved_at in db.execute(select(Circuit.id,Circuit.name,Circuit.approved_at)).all():
        board=table(boards.get(cid,[]),p)
        circuits.append({"id":str(cid),"name":name,"approved":approved_at is not None,"riders":len(board),
                         "hot_seat":board[0] if board else None,"me":next((r for r in board if r["mine"]),None)})
    circuits.sort(key=lambda c:(-c["riders"],c["name"].lower()))
    return {"visible":p.in_records,"circuits":circuits}

@router.put("/me")
def appear(payload:RecordsIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Whether my best times appear in the records."""
    p.in_records=payload.visible
    db.commit()
    return {"visible":p.in_records}

@router.get("/{circuit_id}")
def circuit_records(circuit_id:uuid.UUID,friends:bool=False,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """A circuit's table, who has the best time of each sector, and the runs that do not count."""
    c=load_circuit(db,circuit_id)
    if not c:raise HTTPException(404,"Circuito no encontrado")
    pilots=riders(db,p,friends)
    only=lambda q:q.where(Attempt.circuit_id==c.id,*([Attempt.pilot_id.in_(pilots)] if pilots is not None else []))
    best=best_runs(db,[c.id],pilots)
    # Rides, not files: the same ride sent to a time trial and to training is one.
    runs=dict(db.execute(only(select(Attempt.pilot_id,func.count(func.distinct(Attempt.started_at)))
        .join(Pilot,Pilot.id==Attempt.pilot_id).where(counted())).group_by(Attempt.pilot_id)).all())
    # The best time of each sector in any run that counts, not only in each rider's best run.
    sectors=checked(db,only(select(Attempt,AttemptSplit.sort_order,AttemptSplit.elapsed_ms,Pilot.display_name)
        .join(AttemptSplit,AttemptSplit.attempt_id==Attempt.id).join(Pilot,Pilot.id==Attempt.pilot_id)
        .where(counted(),AttemptSplit.elapsed_ms.is_not(None))
        .order_by(AttemptSplit.sort_order,AttemptSplit.elapsed_ms,Attempt.started_at).ext(distinct_on(AttemptSplit.sort_order))))
    best_sectors=[None]*(len(c.sectors)+1)
    for a,i,ms,name in sectors:
        if i<len(best_sectors):best_sectors[i]={"pilot":name or "Piloto","mine":a.pilot_id==p.id,"elapsed_ms":ms}
    # Runs that look edited or copied: an organizer sees whose and why; a rider, only their own.
    organizer=is_organizer(p)
    flagged=db.execute(select(Attempt,Pilot.display_name,day()).join(Pilot,Pilot.id==Attempt.pilot_id)
        .where(Attempt.circuit_id==c.id,training(),Attempt.checks!=[],*([] if organizer else [Attempt.pilot_id==p.id]))
        .order_by(Attempt.started_at.desc()).limit(50)).all()
    circuit=public_circuit(c)
    circuit["approved"]=c.approved_at is not None
    return {"circuit":circuit,"visible":p.in_records,"rows":table(best,p,runs),"best_sectors":best_sectors,
            "not_counted":[{"pilot":name or "Piloto","mine":a.pilot_id==p.id,"elapsed_ms":a.elapsed_ms,"day":when,
                            **({"reasons":a.checks} if organizer else {})} for a,name,when in flagged]}

def places(db:Session,p:Pilot,circuit_ids:list,new_ids:list)->list[dict]:
    """Where a rider stands on these circuits after uploading these runs: their place, how far from the
    hot seat, whether a new run is their best and whether a new run does not count."""
    if not circuit_ids:return []
    best=best_runs(db,circuit_ids)
    new=db.scalars(select(Attempt).where(Attempt.id.in_(new_ids))).all()
    out=[]
    for cid in circuit_ids:
        board=table([row for row in best if row[0].circuit_id==cid],p)
        me=next((r for r in board if r["mine"]),None)
        mine=next((a for a,_,_ in best if a.circuit_id==cid and a.pilot_id==p.id),None)
        out.append({"circuit_id":str(cid),"riders":len(board),"rank":me["rank"] if me else None,
                    "gap_ms":me["gap_ms"] if me else None,"elapsed_ms":me["elapsed_ms"] if me else None,
                    # On a tie for first, the seat stays with who set the time first.
                    "hot_seat":bool(board) and board[0]["mine"],
                    # Who comes next behind me, when I hold the hot seat.
                    "next":board[1] if board and board[0]["mine"] and len(board)>1 else None,
                    "new_best":mine is not None and mine.id in new_ids,"visible":p.in_records,
                    "not_counted":sum(1 for a in new if a.circuit_id==cid and a.checks)})
    return out
