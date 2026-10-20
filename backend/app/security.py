"""Signed bearer tokens for pilot-private data; production requires HTTPS."""
import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from uuid import UUID

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pwdlib import PasswordHash
from sqlalchemy.orm import Session

from . import config
from .config import require_secret
from .database import get_db
from .models import Pilot

_password_hasher=PasswordHash.recommended()
_bearer=HTTPBearer(auto_error=False)
_ALGORITHM="HS256"
# Riders open the app from their phone now and then: a session lasts a month and the app renews it
# once a day while in use, so only a month without opening it asks for the password again.
SESSION_DAYS=30

def password_hash(password:str)->str:
    return _password_hasher.hash(password)

def verify_password(password:str, encoded:str)->bool:
    return _password_hasher.verify(password,encoded)

# A link to choose a new password lasts this long.
RESET_MINUTES=60

def fingerprint(pilot:Pilot)->str:
    """Changes whenever the password does. Sessions and reset links carry it: a new password ends the
    sessions opened with the old one, and a reset link works once."""
    return hmac.new(require_secret().encode(),pilot.password_hash.encode(),hashlib.sha256).hexdigest()[:16]

def issue_token(pilot:Pilot)->str:
    now=datetime.now(timezone.utc)
    return jwt.encode({"sub":str(pilot.id),"pw":fingerprint(pilot),"iat":now,"exp":now+timedelta(days=SESSION_DAYS),
                       "iss":"dhtrailslocal"},require_secret(),algorithm=_ALGORITHM)

def reset_token(pilot:Pilot)->str:
    """For the link in the mail. Its audience keeps it from ever working as a session."""
    now=datetime.now(timezone.utc)
    return jwt.encode({"sub":str(pilot.id),"aud":"password-reset","pw":fingerprint(pilot),"iat":now,
                       "exp":now+timedelta(minutes=RESET_MINUTES),"iss":"dhtrailslocal"},require_secret(),algorithm=_ALGORITHM)

def pilot_for_reset(db:Session,token:str)->Pilot|None:
    """The rider a reset link is for, while it is valid and unused."""
    try:
        payload=jwt.decode(token,require_secret(),algorithms=[_ALGORITHM],issuer="dhtrailslocal",audience="password-reset")
        pilot=db.get(Pilot,UUID(payload["sub"]))
    except (jwt.InvalidTokenError,ValueError,KeyError,TypeError):
        return None
    return pilot if pilot and hmac.compare_digest(str(payload.get("pw","")),fingerprint(pilot)) else None

def current_pilot(
    credentials:HTTPAuthorizationCredentials|None=Depends(_bearer),
    db:Session=Depends(get_db)
)->Pilot:
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Inicia sesión")
    try:
        payload=jwt.decode(credentials.credentials,require_secret(),algorithms=[_ALGORITHM],issuer="dhtrailslocal")
        user_id=UUID(payload["sub"])
    except (jwt.InvalidTokenError,ValueError,KeyError,TypeError):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Sesión no válida")
    pilot=db.get(Pilot,user_id)
    if not pilot:raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="Piloto no encontrado")
    # Opened before the password was changed. (Sessions from before fingerprints existed carry none and
    # last until the app renews them, within a day.)
    if "pw" in payload and not hmac.compare_digest(str(payload["pw"]),fingerprint(pilot)):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,detail="La contraseña ha cambiado: vuelve a entrar")
    return pilot

def is_organizer(pilot:Pilot)->bool:
    # Read settings at call time so deployments and tests can change them.
    return pilot.email in config.ORGANIZER_EMAILS or (config.LOCAL_SINGLE_USER and pilot.id==config.LOCAL_PILOT_ID)

def require_organizer(pilot:Pilot)->None:
    if not is_organizer(pilot):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,detail="Solo la organización puede hacer esto")

def pilot_payload(pilot:Pilot)->dict:
    return {"id":str(pilot.id),"email":pilot.email,"display_name":pilot.display_name,"organizer":is_organizer(pilot)}
