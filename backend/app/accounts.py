"""Forgotten passwords: a link by mail to choose a new one; and deleting an account with its data.

The link carries a signed token valid for an hour that only works while the password is the one it was
issued for: once used it is worthless, and so are the sessions opened with the old password
(app.security). Whether an address has an account is never told.
"""
import html
import logging
import shutil

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy import delete, exists, or_, select
from sqlalchemy.orm import Session

from . import config
from . import mail
from .database import get_db
from .models import Attempt, Circuit, Pilot, Tournament
from .ratelimit import RateLimit, client_key
from .schemas import DeleteAccountIn, ForgotIn, ResetIn
from .security import (RESET_MINUTES, current_pilot, is_organizer, issue_token, password_hash, pilot_for_reset, pilot_payload,
                       reset_token, verify_password)

router=APIRouter(prefix="/api/auth")
log=logging.getLogger("dhtrails.accounts")
forgot_limit=RateLimit(10,3600)  # requests from one address
mail_limit=RateLimit(3,3600)     # mails to one account
reset_limit=RateLimit(20,3600)
delete_limit=RateLimit(10,3600)
SENT="Si hay una cuenta con ese correo, te llegará en unos minutos un enlace para elegir una contraseña nueva. Mira también en spam."

def send_reset(to:str,name:str|None,token:str)->None:
    """After the response: the answer is the same, and as quick, whether the account exists or not."""
    link=f"{config.PUBLIC_URL}/contrasena.html#t={token}"
    hello="Hola"+(" "+name if name else "")+":"
    text=(f"{hello}\n\nPara elegir una contraseña nueva en DH Trails, abre este enlace. Vale durante "
          f"{RESET_MINUTES} minutos y una sola vez:\n\n{link}\n\nSi no lo has pedido tú, no hagas nada: "
          "tu contraseña sigue siendo la misma.\n\nDH Trails")
    page=(f"<p>{html.escape(hello)}</p><p>Para elegir una contraseña nueva en DH Trails, pulsa aquí. Vale durante "
          f"{RESET_MINUTES} minutos y una sola vez:</p><p><a href=\"{html.escape(link)}\">Elegir una contraseña nueva</a></p>"
          "<p>Si no lo has pedido tú, no hagas nada: tu contraseña sigue siendo la misma.</p><p>DH Trails</p>")
    try:mail.send_mail(to,"DH Trails: elige una contraseña nueva",text,page)
    except Exception:log.exception("No se pudo enviar el correo para recuperar la contraseña")

@router.post("/forgot",status_code=202)
def forgot(payload:ForgotIn,request:Request,background:BackgroundTasks,db:Session=Depends(get_db)):
    if not mail.mail_ready():
        raise HTTPException(503,"La recuperación por correo todavía no está activada. Pide ayuda a la organización.")
    forgot_limit.hit(client_key(request))
    email=str(payload.email).strip().lower()
    p=db.scalar(select(Pilot).where(Pilot.email==email))
    if p:
        try:mail_limit.hit(email)
        except HTTPException:return {"detail":SENT}  # quietly: the answer never tells whether it exists
        background.add_task(send_reset,p.email,p.display_name,reset_token(p))
    return {"detail":SENT}

@router.post("/reset")
def reset(payload:ResetIn,request:Request,db:Session=Depends(get_db)):
    reset_limit.hit(client_key(request))
    p=pilot_for_reset(db,payload.token)
    if not p:raise HTTPException(400,"El enlace no vale o ha caducado. Pide otro desde «¿Has olvidado la contraseña?».")
    p.password_hash=password_hash(payload.password)
    db.commit()
    return {"access_token":issue_token(p),"user":pilot_payload(p)}

@router.post("/delete-account",status_code=204)
def delete_account(payload:DeleteAccountIn,request:Request,db:Session=Depends(get_db),p:Pilot=Depends(current_pilot)):
    """A rider deletes their account, with their password: the account, their routes and their files (GPS and
    the phone's sensors), their runs and tournament entries, notes and friends. A circuit they drew that other
    riders have ridden, or a tournament uses, stays for them and passes to the organization; the others go."""
    delete_limit.hit(client_key(request))
    if not verify_password(payload.password,p.password_hash):raise HTTPException(403,"La contraseña no es correcta")
    if is_organizer(p):
        raise HTTPException(409,"Eres de la organización: esta cuenta no se puede borrar desde aquí")
    shared=db.scalars(select(Circuit).where(Circuit.owner_id==p.id,or_(
        exists().where(Attempt.circuit_id==Circuit.id,Attempt.pilot_id!=p.id),
        exists().where(Tournament.circuit_id==Circuit.id)))).all()
    if shared:
        heir=next((o for o in db.scalars(select(Pilot).where(Pilot.email.in_(config.ORGANIZER_EMAILS))).all()),None)
        if heir is None:raise HTTPException(409,"No se puede borrar ahora: tus circuitos los usan otros pilotos")
        for c in shared:c.owner_id=heir.id
        db.flush()
    # Everything else of the rider goes with the account (the database deletes what hangs from it).
    db.execute(delete(Circuit).where(Circuit.owner_id==p.id))
    db.execute(delete(Pilot).where(Pilot.id==p.id))
    db.commit()
    shutil.rmtree(config.GPS_STORAGE_DIR/str(p.id),ignore_errors=True)
    return Response(status_code=204)
