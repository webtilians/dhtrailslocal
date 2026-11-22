"""Groups: riders out together (a guide's clients, a club, friends) see each other on a map.

A rider creates a group and invites riders by their name; nothing is seen until they accept. Whoever
created it marks who guides and who drives the van up (the shuttle), and anyone in it can put the group's
meeting points on the map. Each rider chooses, group by group, whether to share their location with it:
only then do the others see where they are. The server keeps only the last place of each rider who shares
it, no history, and forgets it a few hours after it stops coming or as soon as they stop sharing.
"""
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from .database import get_db
from .friends import blocked
from .models import GroupMember, MeetingPoint, Pilot, PilotLocation, RideGroup
from .ratelimit import RateLimit
from .security import current_pilot

router=APIRouter(prefix="/api")
group_limit=RateLimit(20,3600)
invite_limit=RateLimit(60,3600)
point_limit=RateLimit(60,3600)
location_limit=RateLimit(90,300)  # per rider: the app sends one every 15 s, or every 5 s when riding fast
MAX_GROUPS=20    # groups a rider may have created
MAX_MEMBERS=60   # riders in a group, invited ones too
MAX_POINTS=30    # meeting points in a group
KEEP=timedelta(hours=3)  # a location not sent again for this long is forgotten

def one_line(text:str)->str:
    return " ".join(text.split())

def named(text:str)->str:
    if not one_line(text):raise ValueError("Ponle un nombre")
    return one_line(text)

class GroupIn(BaseModel):
    name: str = Field(min_length=1,max_length=60)
    @field_validator("name")
    @classmethod
    def clean(cls,v:str)->str:return named(v)

class InviteIn(BaseModel):
    display_name: str = Field(min_length=1,max_length=60)

class RoleIn(BaseModel):
    role: Literal["guide","shuttle"] | None = None

class SharingIn(BaseModel):
    sharing: bool

class LocationIn(BaseModel):
    lat: float = Field(ge=-90,le=90)
    lon: float = Field(ge=-180,le=180)
    ele: float | None = Field(None,ge=-500,le=9000)
    accuracy: float | None = Field(None,ge=0,le=10000)
    speed: float | None = Field(None,ge=0,le=150)

class PointIn(BaseModel):
    name: str = Field(min_length=1,max_length=60)
    lat: float = Field(ge=-90,le=90)
    lon: float = Field(ge=-180,le=180)
    @field_validator("name")
    @classmethod
    def clean(cls,v:str)->str:return named(v)

def now()->datetime:
    return datetime.now(timezone.utc)

def membership(db:Session,group_id:uuid.UUID,pilot_id:uuid.UUID)->GroupMember|None:
    return db.scalar(select(GroupMember).where(GroupMember.group_id==group_id,GroupMember.pilot_id==pilot_id))

def group_for(db:Session,group_id:uuid.UUID,p:Pilot)->tuple[RideGroup,GroupMember]:
    """The group, for a rider in it (accepted): as if it did not exist for anyone else."""
    group=db.get(RideGroup,group_id)
    me=membership(db,group_id,p.id) if group else None
    if not group or not me or not me.accepted_at:raise HTTPException(404,"Grupo no encontrado")
    return group,me

def own_group(db:Session,group_id:uuid.UUID,p:Pilot)->RideGroup:
    group,_=group_for(db,group_id,p)
    if group.owner_id!=p.id:raise HTTPException(403,"Eso solo puede hacerlo quien ha creado el grupo")
    return group

def forget_if_unshared(db:Session,*pilot_ids:uuid.UUID):
    """A rider who no longer shares their location with any group: their last place goes at once."""
    for pilot_id in pilot_ids:
        still=db.scalar(select(GroupMember.id).where(GroupMember.pilot_id==pilot_id,GroupMember.sharing.is_(True),
                                                     GroupMember.accepted_at.is_not(None)).limit(1))
        if still is None:db.execute(delete(PilotLocation).where(PilotLocation.pilot_id==pilot_id))

@router.get("/groups")
def my_groups(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    rows=db.execute(select(GroupMember,RideGroup,Pilot).join(RideGroup,RideGroup.id==GroupMember.group_id)
        .join(Pilot,Pilot.id==RideGroup.owner_id).where(GroupMember.pilot_id==p.id).order_by(RideGroup.created_at.desc())).all()
    ids=[g.id for _,g,_ in rows]
    counts=dict(db.execute(select(GroupMember.group_id,func.count()).where(GroupMember.group_id.in_(ids),
        GroupMember.accepted_at.is_not(None)).group_by(GroupMember.group_id)).all()) if ids else {}
    inviters={pid:name for pid,name in db.execute(select(Pilot.id,Pilot.display_name)
        .where(Pilot.id.in_([m.invited_by for m,_,_ in rows if m.invited_by]))).all()}
    return {
        "groups":[{"id":str(g.id),"name":g.name,"owner":o.display_name or "Piloto","mine":g.owner_id==p.id,
                   "members":counts.get(g.id,0),"sharing":m.sharing,"role":m.role} for m,g,o in rows if m.accepted_at],
        "invitations":[{"id":str(g.id),"name":g.name,"owner":o.display_name or "Piloto","members":counts.get(g.id,0),
                        "invited_by":inviters.get(m.invited_by) or o.display_name or "Piloto"} for m,g,o in rows if not m.accepted_at],
    }

@router.post("/groups",status_code=201)
def create_group(payload:GroupIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    group_limit.hit(str(p.id))
    if not p.display_name:raise HTTPException(409,"Elige primero tu nombre de piloto: es como te verá el grupo")
    if db.scalar(select(func.count()).select_from(RideGroup).where(RideGroup.owner_id==p.id))>=MAX_GROUPS:
        raise HTTPException(409,"Has llegado al máximo de grupos: borra alguno antes de crear otro")
    group=RideGroup(name=payload.name,owner_id=p.id)
    db.add(group)
    db.flush()
    db.add(GroupMember(group_id=group.id,pilot_id=p.id,accepted_at=now()))
    db.commit()
    return {"id":str(group.id),"name":group.name}

@router.get("/groups/{group_id}")
def group_map(group_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Who is in the group, where those who share it are (and since when), and its meeting points."""
    group,me=group_for(db,group_id,p)
    at=now()
    rows=db.execute(select(GroupMember,Pilot,PilotLocation).join(Pilot,Pilot.id==GroupMember.pilot_id)
        .outerjoin(PilotLocation,PilotLocation.pilot_id==GroupMember.pilot_id)
        .where(GroupMember.group_id==group.id).order_by(func.lower(Pilot.display_name))).all()
    def position(m:GroupMember,loc:PilotLocation|None):
        if not (m.accepted_at and m.sharing and loc and at-loc.updated_at<=KEEP):return None
        return {"lat":loc.lat,"lon":loc.lon,"ele":loc.ele,"accuracy":loc.accuracy_m,"speed":loc.speed,
                "age_s":max(0,round((at-loc.updated_at).total_seconds()))}
    names={pilot.id:pilot.display_name or "Piloto" for _,pilot,_ in rows}
    points=db.scalars(select(MeetingPoint).where(MeetingPoint.group_id==group.id).order_by(MeetingPoint.created_at)).all()
    missing=[x.created_by for x in points if x.created_by and x.created_by not in names]
    if missing:names.update({pid:name or "Piloto" for pid,name in db.execute(select(Pilot.id,Pilot.display_name).where(Pilot.id.in_(missing))).all()})
    return {
        "id":str(group.id),"name":group.name,"mine":group.owner_id==p.id,"sharing":me.sharing,
        "members":[{"id":str(pilot.id),"name":pilot.display_name or "Piloto","me":pilot.id==p.id,"owner":pilot.id==group.owner_id,
                    "accepted":m.accepted_at is not None,"sharing":bool(m.accepted_at and m.sharing),"role":m.role,
                    "position":position(m,loc)} for m,pilot,loc in rows],
        "points":[{"id":str(x.id),"name":x.name,"lat":x.lat,"lon":x.lon,"by":names.get(x.created_by),
                   "can_delete":x.created_by==p.id or group.owner_id==p.id} for x in points],
    }

@router.delete("/groups/{group_id}",status_code=204)
def delete_group(group_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    group=own_group(db,group_id,p)
    riders=db.scalars(select(GroupMember.pilot_id).where(GroupMember.group_id==group.id)).all()
    db.delete(group)
    db.flush()
    forget_if_unshared(db,*riders)
    db.commit()
    return Response(status_code=204)

@router.post("/groups/{group_id}/members",status_code=201)
def invite(group_id:uuid.UUID,payload:InviteIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    invite_limit.hit(str(p.id))
    group=own_group(db,group_id,p)
    name=one_line(payload.display_name)
    other=db.scalar(select(Pilot).where(func.lower(Pilot.display_name)==name.lower()))
    # A rider blocked on the board, either way, can't be invited: as if there were nobody by that name.
    if not other or blocked(db,p.id,other.id):raise HTTPException(404,"No hay ningún piloto con ese nombre")
    if other.id==p.id:raise HTTPException(422,"Ese nombre es el tuyo")
    existing=membership(db,group.id,other.id)
    if existing and existing.accepted_at:raise HTTPException(409,f"{other.display_name} ya está en el grupo")
    if existing:raise HTTPException(409,f"Ya invitaste a {other.display_name}")
    if db.scalar(select(func.count()).select_from(GroupMember).where(GroupMember.group_id==group.id))>=MAX_MEMBERS:
        raise HTTPException(409,"El grupo ya está completo")
    db.add(GroupMember(group_id=group.id,pilot_id=other.id,invited_by=p.id))
    db.commit()
    return {"status":"invited","name":other.display_name}

@router.post("/groups/{group_id}/accept")
def accept(group_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    invitation=membership(db,group_id,p.id)
    if not invitation or invitation.accepted_at:raise HTTPException(404,"Invitación no encontrada")
    invitation.accepted_at=now()
    db.commit()
    return {"status":"accepted"}

@router.delete("/groups/{group_id}/members/{pilot_id}",status_code=204)
def remove_member(group_id:uuid.UUID,pilot_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """A rider leaves the group or turns its invitation down; whoever created it takes someone out."""
    group=db.get(RideGroup,group_id)
    mine=membership(db,group_id,p.id) if group else None
    if not group or not mine:raise HTTPException(404,"Grupo no encontrado")
    if pilot_id==p.id:
        if group.owner_id==p.id:raise HTTPException(409,"Has creado tú el grupo: si ya no lo necesitas, bórralo")
        target=mine
    else:
        if group.owner_id!=p.id or not mine.accepted_at:raise HTTPException(403,"Eso solo puede hacerlo quien ha creado el grupo")
        target=membership(db,group_id,pilot_id)
        if not target:raise HTTPException(404,"Ese piloto no está en el grupo")
    db.delete(target)
    db.flush()
    forget_if_unshared(db,pilot_id)
    db.commit()
    return Response(status_code=204)

@router.put("/groups/{group_id}/members/{pilot_id}/role")
def set_role(group_id:uuid.UUID,pilot_id:uuid.UUID,payload:RoleIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """Who guides the group, who drives the van up, or neither: marked by whoever created it."""
    group=own_group(db,group_id,p)
    member=membership(db,group.id,pilot_id)
    if not member:raise HTTPException(404,"Ese piloto no está en el grupo")
    member.role=payload.role
    db.commit()
    return {"role":member.role}

@router.put("/groups/{group_id}/sharing")
def share(group_id:uuid.UUID,payload:SharingIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    _,me=group_for(db,group_id,p)
    me.sharing=payload.sharing
    db.flush()
    if not payload.sharing:forget_if_unshared(db,p.id)
    db.commit()
    return {"sharing":me.sharing}

@router.post("/location",status_code=204)
def send_location(payload:LocationIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """The rider's place now, for the groups they share it with. Only the last one is kept."""
    location_limit.hit(str(p.id))
    sharing=db.scalar(select(GroupMember.id).where(GroupMember.pilot_id==p.id,GroupMember.sharing.is_(True),
                                                   GroupMember.accepted_at.is_not(None)).limit(1))
    if sharing is None:raise HTTPException(409,"No compartes tu ubicación con ningún grupo")
    values={"lat":payload.lat,"lon":payload.lon,"ele":payload.ele,"accuracy_m":payload.accuracy,"speed":payload.speed,"updated_at":now()}
    db.execute(insert(PilotLocation).values(pilot_id=p.id,**values).on_conflict_do_update(index_elements=[PilotLocation.pilot_id],set_=values))
    # Places not sent again for hours are no use to anyone: forgotten.
    db.execute(delete(PilotLocation).where(PilotLocation.updated_at<now()-KEEP))
    db.commit()
    return Response(status_code=204)

@router.post("/groups/{group_id}/points",status_code=201)
def add_point(group_id:uuid.UUID,payload:PointIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    point_limit.hit(str(p.id))
    group,_=group_for(db,group_id,p)
    if db.scalar(select(func.count()).select_from(MeetingPoint).where(MeetingPoint.group_id==group.id))>=MAX_POINTS:
        raise HTTPException(409,"El grupo ya tiene 30 puntos de encuentro: borra alguno antes de añadir otro")
    point=MeetingPoint(group_id=group.id,created_by=p.id,name=payload.name,lat=payload.lat,lon=payload.lon)
    db.add(point)
    db.commit()
    return {"id":str(point.id),"name":point.name,"lat":point.lat,"lon":point.lon,"by":p.display_name,"can_delete":True}

@router.delete("/groups/{group_id}/points/{point_id}",status_code=204)
def delete_point(group_id:uuid.UUID,point_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    group,_=group_for(db,group_id,p)
    point=db.scalar(select(MeetingPoint).where(MeetingPoint.id==point_id,MeetingPoint.group_id==group.id))
    if not point:raise HTTPException(404,"Punto de encuentro no encontrado")
    if point.created_by!=p.id and group.owner_id!=p.id:
        raise HTTPException(403,"Solo puede quitarlo quien lo puso o quien ha creado el grupo")
    db.delete(point)
    db.commit()
    return Response(status_code=204)
