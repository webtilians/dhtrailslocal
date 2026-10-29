"""The board: what a rider and their friends have been doing, and every rider's time trials and hot seats.

Its posts are not stored: they are made from the runs, entries and circuits there are, and a post's key
names what it comes from. Training runs are shown only to the rider's friends, as in training; time trial
results and records are public anyway. On a post riders leave a 🔥 and comments, seen by whoever sees the
post. A comment can be reported to the organization (whoever reports it stops seeing it, and with three
reports nobody sees it until an organizer decides), and a rider can block another: then neither sees the
other on the board, and they stop being friends.
"""
import re
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session, defer

from . import config
from .database import get_db
from .friends import between, friend_ids
from .models import Attempt, Circuit, FeedComment, FeedReaction, FeedReport, Friendship, Pilot, PilotBlock, Tournament
from .ratelimit import RateLimit
from .records import checked, counted
from .security import current_pilot, is_organizer

router=APIRouter(prefix="/api/feed")
comment_limit=RateLimit(30,3600)
WINDOW=timedelta(days=120)  # how far back the board goes
PAGE=25
HIDE_AT=3  # reports that hide a comment from everyone until an organizer decides

class PostIn(BaseModel):
    post: str = Field(min_length=1,max_length=120)

class CommentIn(PostIn):
    text: str = Field(min_length=1,max_length=300)

class BlockIn(BaseModel):
    pilot_id: uuid.UUID

def day(column):
    return func.to_char(func.timezone(config.COMPETITION_TIMEZONE,column),"YYYY-MM-DD")

def hidden_from(db:Session,pilot_id:uuid.UUID)->set[uuid.UUID]:
    """The riders this one has blocked or has been blocked by."""
    rows=db.execute(select(PilotBlock.blocker_id,PilotBlock.blocked_id)
        .where(or_(PilotBlock.blocker_id==pilot_id,PilotBlock.blocked_id==pilot_id))).all()
    return {b if a==pilot_id else a for a,b in rows}

def clean():
    """Training runs without signs of an edited or copied file (or not checked yet)."""
    return Attempt.checks.is_(None)|(Attempt.checks==[])

def training_runs():
    return ((Attempt.tournament_id.is_(None))&(Attempt.review_status.is_(None))&(Attempt.timed_by=="server")
            &(Attempt.elapsed_ms.is_not(None))&(Attempt.started_at.is_not(None))&clean())

# ---- The posts

def training_posts(db:Session,riders:list,since:datetime)->list[dict]:
    """A rider's runs on a circuit on a day, as one post: how many, the best, and whether it beats what the
    rider had done there before (or is their first time there). A ride also sent to a time trial is its entry."""
    rows=db.execute(select(Attempt.id,Attempt.pilot_id,Attempt.circuit_id,Attempt.started_at,Attempt.elapsed_ms,
                           Attempt.created_at,day(Attempt.started_at))
        .where(Attempt.pilot_id.in_(riders),training_runs()).order_by(Attempt.started_at)).all()
    entered={(a,c,round(s.timestamp())) for a,c,s in db.execute(select(Attempt.pilot_id,Attempt.circuit_id,Attempt.started_at)
        .where(Attempt.pilot_id.in_(riders),Attempt.tournament_id.is_not(None),Attempt.started_at.is_not(None))).all()}
    groups={}
    for rid,pid,cid,started,ms,created,when in rows:
        if (pid,cid,round(started.timestamp())) in entered:continue
        groups.setdefault((pid,cid,when),[]).append((ms,str(rid),created))
    posts,best=[],{}
    for (pid,cid,when),runs in sorted(groups.items(),key=lambda kv:kv[0][2]):
        fastest=min(runs)
        before=best.get((pid,cid))
        best[(pid,cid)]=fastest[0] if before is None else min(before,fastest[0])
        at=max(created for _,_,created in runs)
        if at<since:continue
        posts.append({"key":f"train:{pid}:{cid}:{when}","kind":"train","at":at,"pilot_id":pid,"circuit_id":cid,
                      "day":when,"runs":len(runs),"elapsed_ms":fastest[0],"run_id":fastest[1],
                      "previous_best_ms":before,"first":before is None,
                      "personal_best":before is not None and fastest[0]<before})
    return posts

def entry_posts(db:Session,since:datetime,hidden:set)->list[dict]:
    """Every accepted time trial entry, with where its rider stands in that time trial."""
    at=func.coalesce(Attempt.reviewed_at,Attempt.created_at)
    rows=db.execute(select(Attempt,Tournament.name,Tournament.circuit_id,at).join(Tournament,Tournament.id==Attempt.tournament_id)
        .options(defer(Attempt.profile)).where(Attempt.review_status=="approved",Attempt.elapsed_ms.is_not(None),at>=since)).all()
    boards={}
    if rows:
        for tid,pid,ms in db.execute(select(Attempt.tournament_id,Attempt.pilot_id,func.min(Attempt.elapsed_ms))
                .where(Attempt.tournament_id.in_({a.tournament_id for a,*_ in rows}),Attempt.review_status=="approved",
                       Attempt.elapsed_ms.is_not(None)).group_by(Attempt.tournament_id,Attempt.pilot_id)).all():
            boards.setdefault(tid,{})[pid]=ms
    posts=[]
    for a,name,cid,when in rows:
        if a.pilot_id in hidden:continue
        board=boards.get(a.tournament_id,{})
        mine=board.get(a.pilot_id,a.elapsed_ms)
        posts.append({"key":f"entry:{a.id}","kind":"entry","at":when,"pilot_id":a.pilot_id,"circuit_id":cid,
                      "tournament":{"id":str(a.tournament_id),"name":name},"elapsed_ms":a.elapsed_ms,"run_id":str(a.id),
                      "rank":1+sum(1 for ms in board.values() if ms<mine),"riders":len(board),"its_best":a.elapsed_ms==mine})
    return posts

def seat_posts(db:Session,since:datetime,hidden:set)->list[dict]:
    """Each time a rider takes a circuit's hot seat (or lowers their own time in it), from every run that
    counts for the records, in the order they were ridden."""
    rows=checked(db,select(Attempt,Pilot.display_name).join(Pilot,Pilot.id==Attempt.pilot_id).where(counted())
                 .options(defer(Attempt.profile)).order_by(Attempt.started_at,Attempt.created_at))
    holders,posts={},[]
    for a,name in rows:
        held=holders.get(a.circuit_id)
        if held and a.elapsed_ms>=held[0]:continue
        holders[a.circuit_id]=(a.elapsed_ms,a.pilot_id,name)
        if a.created_at<since or a.pilot_id in hidden:continue
        # Whom it was taken from, but not by name if this rider and they have blocked each other.
        previous=None if not held else {"pilot":(held[2] if held[1] not in hidden else None) or "Piloto",
                                        "elapsed_ms":held[0],"same":held[1]==a.pilot_id}
        posts.append({"key":f"seat:{a.id}","kind":"seat","at":a.created_at,"pilot_id":a.pilot_id,"circuit_id":a.circuit_id,
                      "elapsed_ms":a.elapsed_ms,"run_id":str(a.id),"tournament":a.tournament_id is not None,"previous":previous})
    return posts

def circuit_posts(db:Session,riders:list,since:datetime,hidden:set)->list[dict]:
    """New circuits: a friend's (or mine), and any the organization accepts for time trials."""
    at=func.coalesce(Circuit.approved_at,Circuit.created_at)
    rows=db.execute(select(Circuit.id,Circuit.owner_id,Circuit.approved_at,at)
        .where(or_(Circuit.owner_id.in_(riders),Circuit.approved_at.is_not(None)),at>=since)).all()
    return [{"key":f"circuit:{cid}","kind":"circuit","at":when,"pilot_id":owner,"circuit_id":cid,"approved":approved is not None}
            for cid,owner,approved,when in rows if owner not in hidden]

# ---- Who sees a post

def post_owner(db:Session,p:Pilot,key:str)->uuid.UUID:
    """The rider a post is about, when this rider can see it; else 404."""
    hidden=hidden_from(db,p.id)
    kind,_,rest=key.partition(":")
    owner=None
    try:
        if kind=="train":
            pid,cid,when=rest.split(":")
            pid,cid=uuid.UUID(pid),uuid.UUID(cid)
            if pid in {p.id,*friend_ids(db,p.id)} and db.scalar(select(Attempt.id).where(
                    Attempt.pilot_id==pid,Attempt.circuit_id==cid,training_runs(),day(Attempt.started_at)==when).limit(1)):
                owner=pid
        elif kind in ("entry","seat"):
            a=db.get(Attempt,uuid.UUID(rest))
            if a and a.elapsed_ms is not None and (a.review_status=="approved" if kind=="entry" else a.timed_by=="server"):
                owner=a.pilot_id
        elif kind=="circuit":
            c=db.get(Circuit,uuid.UUID(rest))
            if c and (c.approved_at or c.owner_id in {p.id,*friend_ids(db,p.id)}):owner=c.owner_id
    except ValueError:
        owner=None
    if owner is None or owner in hidden:raise HTTPException(404,"Publicación no encontrada")
    return owner

# ---- What can't be written

# Insults and slurs (in Spanish and English), checked word by word once accents and look-alike digits are
# undone. Not the everyday swearing riders use among friends.
BANNED={"puta","putas","hijoputa","hijoputas","gilipollas","subnormal","subnormales","retrasado","retrasada","retrasados",
        "mongolo","mongola","maricon","maricones","marica","bollera","zorra","zorras","sudaca","sudacas","panchito",
        "cunt","cunts","faggot","fag","fags","nigger","niggers","nigga","retard","retards","whore","whores","slut","bitch"}
BANNED_PHRASES=("hijo de puta","hija de puta","fuck you","kill yourself","matate","suicidate")
LOOKALIKE=str.maketrans({"0":"o","1":"i","3":"e","4":"a","5":"s","7":"t","@":"a","$":"s","á":"a","é":"e","í":"i",
                         "ó":"o","ú":"u","ü":"u","à":"a","è":"e","ì":"i","ò":"o","ù":"u"})

def unfit(text:str)->bool:
    plain=text.lower().translate(LOOKALIKE)
    words=re.findall(r"[a-zñ]+",plain)
    joined=" ".join(words)
    return any(w in BANNED for w in words) or any(p in joined for p in BANNED_PHRASES)

# ---- The board

def reactions_of(db:Session,p:Pilot,keys:list,hidden:set)->dict:
    out={k:{"count":0,"mine":False,"names":[]} for k in keys}
    for key,pid,name in db.execute(select(FeedReaction.post_key,FeedReaction.pilot_id,Pilot.display_name)
            .join(Pilot,Pilot.id==FeedReaction.pilot_id).where(FeedReaction.post_key.in_(keys))
            .order_by(FeedReaction.created_at)).all():
        if pid in hidden:continue
        r=out[key]
        r["count"]+=1
        r["mine"]=r["mine"] or pid==p.id
        r["names"].append(name or "Piloto")
    return out

def comments_of(db:Session,p:Pilot,owners:dict,hidden:set)->dict:
    """The comments on these posts this rider sees: not the ones they reported, nor the ones reported
    enough times (an organizer still sees those, to decide)."""
    organizer=is_organizer(p)
    reports=func.count(FeedReport.id)
    rows=db.execute(select(FeedComment,Pilot.display_name,reports,
                           func.bool_or(FeedReport.reporter_id==p.id))
        .join(Pilot,Pilot.id==FeedComment.pilot_id).outerjoin(FeedReport,FeedReport.comment_id==FeedComment.id)
        .where(FeedComment.post_key.in_(list(owners))).group_by(FeedComment.id,Pilot.display_name)
        .order_by(FeedComment.created_at)).all()
    out={k:[] for k in owners}
    for c,name,count,reported in rows:
        if c.pilot_id in hidden or reported or (count>=HIDE_AT and not organizer):continue
        out[c.post_key].append(comment_payload(c,name,p,owners[c.post_key],organizer,count))
    return out

def comment_payload(c:FeedComment,name:str|None,p:Pilot,owner:uuid.UUID,organizer:bool,reports:int=0)->dict:
    return {"id":str(c.id),"pilot":name or "Piloto","pilot_id":str(c.pilot_id),"mine":c.pilot_id==p.id,
            "text":c.text,"at":c.created_at.isoformat(),
            # Its author, the rider the post is about and the organization can delete it.
            "can_delete":c.pilot_id==p.id or owner==p.id or organizer,
            **({"reports":reports} if organizer and reports else {})}

@router.get("")
def board(before:datetime|None=None,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    hidden=hidden_from(db,p.id)
    riders=[p.id,*(f for f in friend_ids(db,p.id) if f not in hidden)]
    since=datetime.now(timezone.utc)-WINDOW
    posts=[*training_posts(db,riders,since),*entry_posts(db,since,hidden),*seat_posts(db,since,hidden),
           *circuit_posts(db,riders,since,hidden)]
    posts.sort(key=lambda x:x["at"],reverse=True)
    if before:
        if before.tzinfo is None:before=before.replace(tzinfo=timezone.utc)
        posts=[x for x in posts if x["at"]<before]
    page=posts[:PAGE]
    names=dict(db.execute(select(Pilot.id,Pilot.display_name).where(Pilot.id.in_({x["pilot_id"] for x in page}))).all())
    circuits=dict(db.execute(select(Circuit.id,Circuit.name).where(Circuit.id.in_({x["circuit_id"] for x in page}))).all())
    keys=[x["key"] for x in page]
    reactions=reactions_of(db,p,keys,hidden)
    comments=comments_of(db,p,{x["key"]:x["pilot_id"] for x in page},hidden)
    out=[]
    for x in page:
        out.append({**x,"at":x["at"].isoformat(),"pilot_id":str(x["pilot_id"]),"pilot":names.get(x["pilot_id"]) or "Piloto",
                    "mine":x["pilot_id"]==p.id,"circuit_id":str(x["circuit_id"]),"circuit":circuits.get(x["circuit_id"]),
                    "reactions":reactions[x["key"]],"comments":comments[x["key"]]})
    reported=None
    if is_organizer(p):
        reported=db.scalar(select(func.count(func.distinct(FeedReport.comment_id))))
    return {"posts":out,"next":page[-1]["at"].isoformat() if len(posts)>PAGE else None,"reported":reported}

@router.post("/reactions")
def react(payload:PostIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """A 🔥 on a post, or taking it back."""
    post_owner(db,p,payload.post)
    mine=db.scalar(select(FeedReaction).where(FeedReaction.post_key==payload.post,FeedReaction.pilot_id==p.id))
    if mine:db.delete(mine)
    else:db.add(FeedReaction(post_key=payload.post,pilot_id=p.id))
    db.commit()
    return reactions_of(db,p,[payload.post],hidden_from(db,p.id))[payload.post]

@router.post("/comments",status_code=201)
def comment(payload:CommentIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    comment_limit.hit(str(p.id))
    if not p.display_name:raise HTTPException(409,"Elige primero tu nombre de piloto: es el que verán con tu comentario")
    owner=post_owner(db,p,payload.post)
    text=" ".join(payload.text.split())
    if not text:raise HTTPException(422,"Escribe algo en el comentario")
    if unfit(text):raise HTTPException(422,"El comentario lleva palabras que no se pueden publicar en el tablón")
    c=FeedComment(post_key=payload.post,pilot_id=p.id,text=text)
    db.add(c);db.commit()
    return comment_payload(c,p.display_name,p,owner,is_organizer(p))

@router.delete("/comments/{comment_id}",status_code=204)
def delete_comment(comment_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=db.get(FeedComment,comment_id)
    if not c:raise HTTPException(404,"Comentario no encontrado")
    if c.pilot_id!=p.id and not is_organizer(p):
        try:owner=post_owner(db,p,c.post_key)
        except HTTPException:owner=None
        if owner!=p.id:raise HTTPException(403,"Solo pueden borrarlo quien lo escribió, el piloto de la publicación y la organización")
    db.delete(c);db.commit()

@router.post("/comments/{comment_id}/report",status_code=204)
def report(comment_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    c=db.get(FeedComment,comment_id)
    if not c:raise HTTPException(404,"Comentario no encontrado")
    post_owner(db,p,c.post_key)
    if c.pilot_id==p.id:raise HTTPException(422,"No puedes denunciar tu propio comentario: bórralo")
    if not db.scalar(select(FeedReport.id).where(FeedReport.comment_id==c.id,FeedReport.reporter_id==p.id)):
        db.add(FeedReport(comment_id=c.id,reporter_id=p.id));db.commit()

@router.get("/reports")
def reports(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """For the organization: the reported comments, most reported first."""
    if not is_organizer(p):raise HTTPException(403,"Solo para la organización")
    count=func.count(FeedReport.id)
    rows=db.execute(select(FeedComment,Pilot.display_name,count).join(Pilot,Pilot.id==FeedComment.pilot_id)
        .join(FeedReport,FeedReport.comment_id==FeedComment.id).group_by(FeedComment.id,Pilot.display_name)
        .order_by(count.desc(),FeedComment.created_at)).all()
    return [{**comment_payload(c,name,p,c.pilot_id,True,n),"post":c.post_key} for c,name,n in rows]

@router.post("/comments/{comment_id}/keep",status_code=204)
def keep(comment_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """The organization finds a reported comment fine: its reports go, and everyone sees it again."""
    if not is_organizer(p):raise HTTPException(403,"Solo para la organización")
    db.execute(delete(FeedReport).where(FeedReport.comment_id==comment_id));db.commit()

@router.get("/blocks")
def blocks(db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    rows=db.execute(select(Pilot.id,Pilot.display_name).join(PilotBlock,PilotBlock.blocked_id==Pilot.id)
        .where(PilotBlock.blocker_id==p.id).order_by(Pilot.display_name)).all()
    return [{"id":str(pid),"name":name or "Piloto"} for pid,name in rows]

@router.post("/blocks",status_code=201)
def block(payload:BlockIn,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    if payload.pilot_id==p.id:raise HTTPException(422,"No puedes bloquearte a ti mismo")
    other=db.get(Pilot,payload.pilot_id)
    if not other:raise HTTPException(404,"Piloto no encontrado")
    if not db.scalar(select(PilotBlock.id).where(PilotBlock.blocker_id==p.id,PilotBlock.blocked_id==other.id)):
        db.add(PilotBlock(blocker_id=p.id,blocked_id=other.id))
    # No longer friends, nor asking to be.
    db.execute(delete(Friendship).where(between(p.id,other.id)))
    db.commit()
    return {"id":str(other.id),"name":other.display_name or "Piloto"}

@router.delete("/blocks/{pilot_id}",status_code=204)
def unblock(pilot_id:uuid.UUID,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    db.execute(delete(PilotBlock).where(PilotBlock.blocker_id==p.id,PilotBlock.blocked_id==pilot_id));db.commit()
