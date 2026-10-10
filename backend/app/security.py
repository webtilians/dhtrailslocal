"""Signed bearer tokens for pilot-private data; production requires HTTPS."""
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

def password_hash(password:str)->str:
    return _password_hasher.hash(password)

def verify_password(password:str, encoded:str)->bool:
    return _password_hasher.verify(password,encoded)

def issue_token(pilot_id:UUID)->str:
    exp=datetime.now(timezone.utc)+timedelta(hours=12)
    return jwt.encode({"sub":str(pilot_id),"exp":exp,"iss":"dhtrailslocal"},require_secret(),algorithm=_ALGORITHM)

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
    return pilot

def is_organizer(pilot:Pilot)->bool:
    # Read settings at call time so deployments and tests can change them.
    return pilot.email in config.ORGANIZER_EMAILS or (config.LOCAL_SINGLE_USER and pilot.id==config.LOCAL_PILOT_ID)

def require_organizer(pilot:Pilot)->None:
    if not is_organizer(pilot):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,detail="Solo la organización puede hacer esto")

def pilot_payload(pilot:Pilot)->dict:
    return {"id":str(pilot.id),"email":pilot.email,"display_name":pilot.display_name,"organizer":is_organizer(pilot)}
