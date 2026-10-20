"""Forgotten passwords: a link by mail to choose a new one.

The link carries a signed token valid for an hour that only works while the password is the one it was
issued for: once used it is worthless, and so are the sessions opened with the old password
(app.security). Whether an address has an account is never told.
"""
import html
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import config
from . import mail
from .database import get_db
from .models import Pilot
from .ratelimit import RateLimit, client_key
from .schemas import ForgotIn, ResetIn
from .security import RESET_MINUTES, issue_token, password_hash, pilot_for_reset, pilot_payload, reset_token

router=APIRouter(prefix="/api/auth")
log=logging.getLogger("dhtrails.accounts")
forgot_limit=RateLimit(10,3600)  # requests from one address
mail_limit=RateLimit(3,3600)     # mails to one account
reset_limit=RateLimit(20,3600)
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
