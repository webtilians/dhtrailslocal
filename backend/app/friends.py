"""Friends: two riders who accept each other can compare their training runs.

A request goes to a rider by their name in the standings. Until it is accepted nothing is
shared; once accepted, each sees the other's runs on the app's circuits (never whole routes).
Either of them can undo it at any time.
"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from .database import get_db
from .models import Friendship, Pilot
from .ratelimit import RateLimit
from .security import current_pilot

router=APIRouter(prefix="/api/friends")
request_limit=RateLimit(30,3600)

class FriendIn(BaseModel):
    display_name: str = Field(min_length=1,max_length=60)

def between(a:uuid.UUID,b:uuid.UUID):
    return or_(and_(Friendship.requester_id==a,Friendship.addressee_id==b),
               and_(Friendship.requester_id==b,Friendship.addressee_id==a))

def friend_ids(db:Session,pilot_id:uuid.UUID)->list[uuid.UUID]:
    """Riders whose friendship with pilot_id has been accepted."""
    rows=db.execute(select(Friendship.requester_id,Friendship.addressee_id)
        .where(Friendship.accepted_at.is_not(None),
               or_(Friendship.requester_id==pilot_id,Friendship.addressee_id==pilot_id))).all()
    return [b if a==pilot_id else a for a,b in rows]

@router.get("")
def my_friends(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    rows=db.execute(select(Friendship,Pilot).join(Pilot,or_(
            and_(Friendship.requester_id==p.id,Pilot.id==Friendship.addressee_id),
            and_(Friendship.addressee_id==p.id,Pilot.id==Friendship.requester_id)))
        .order_by(Pilot.display_name)).all()
    item=lambda other:{"id":str(other.id),"name":other.display_name or "Piloto"}
    return {"friends":[item(o) for f,o in rows if f.accepted_at],
            "incoming":[item(o) for f,o in rows if not f.accepted_at and f.addressee_id==p.id],
            "outgoing":[item(o) for f,o in rows if not f.accepted_at and f.requester_id==p.id]}

@router.post("",status_code=201)
def ask(payload:FriendIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    request_limit.hit(str(p.id))
    if not p.display_name:raise HTTPException(409,"Elige primero tu nombre de piloto: es como te verá tu amigo")
    name=" ".join(payload.display_name.split())
    other=db.scalar(select(Pilot).where(func.lower(Pilot.display_name)==name.lower()))
    if not other:raise HTTPException(404,"No hay ningún piloto con ese nombre")
    if other.id==p.id:raise HTTPException(422,"Ese nombre es el tuyo")
    existing=db.scalar(select(Friendship).where(between(p.id,other.id)))
    if existing and existing.accepted_at:raise HTTPException(409,f"Ya sois amigos con {other.display_name}")
    if existing and existing.requester_id==p.id:raise HTTPException(409,f"Ya le enviaste una solicitud a {other.display_name}")
    if existing:
        # They had already asked: asking back is accepting.
        existing.accepted_at=datetime.now(timezone.utc)
        db.commit()
        return {"status":"accepted","name":other.display_name}
    db.add(Friendship(requester_id=p.id,addressee_id=other.id))
    db.commit()
    return {"status":"pending","name":other.display_name}

@router.post("/{pilot_id}/accept")
def accept(pilot_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    request=db.scalar(select(Friendship).where(Friendship.requester_id==pilot_id,Friendship.addressee_id==p.id,
                                               Friendship.accepted_at.is_(None)))
    if not request:raise HTTPException(404,"Solicitud no encontrada")
    request.accepted_at=datetime.now(timezone.utc)
    db.commit()
    return {"status":"accepted"}

@router.delete("/{pilot_id}",status_code=204)
def remove(pilot_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Cancel, reject or end a friendship: nothing stays shared."""
    friendship=db.scalar(select(Friendship).where(between(p.id,pilot_id)))
    if not friendship:raise HTTPException(404,"No hay ninguna amistad ni solicitud con ese piloto")
    db.delete(friendship)
    db.commit()
