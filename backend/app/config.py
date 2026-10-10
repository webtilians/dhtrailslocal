"""Runtime settings; development defaults never expose a secret or DB externally."""
import os
import uuid
from pathlib import Path
from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_DIR.parent
load_dotenv(BACKEND_DIR / ".env")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://dhtrails:dhtrails_local_only@127.0.0.1:5432/dhtrails")
SECRET_KEY = os.getenv("SECRET_KEY", "")
CORS_ORIGINS = [x.strip() for x in os.getenv("CORS_ORIGINS", "http://127.0.0.1:8000,http://localhost:8000").split(",") if x.strip()]
GPS_STORAGE_DIR = Path(os.getenv("GPS_STORAGE_DIR", str(BACKEND_DIR / "data" / "activities"))).resolve()
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
API_HOST = os.getenv("API_HOST", "127.0.0.1")
API_PORT = int(os.getenv("API_PORT", "8000"))

def require_secret() -> str:
    if len(SECRET_KEY) < 32 or SECRET_KEY.startswith("CHANGE_ME"):
        raise RuntimeError("Configura un SECRET_KEY aleatorio de 32+ caracteres en backend/.env")
    return SECRET_KEY

# Explicit opt-in for this desktop installation only.
LOCAL_SINGLE_USER = os.getenv("LOCAL_SINGLE_USER", "false").lower() == "true"
LOCAL_PILOT_ID = uuid.UUID("d48951f3-59a3-49b1-9635-ea0da0fb5d87")

# Monthly competition. Organizers publish circuits and approve entries; on the
# desktop the local profile is the organizer. A non-empty INVITE_CODE closes
# public sign-up to riders who received the code.
ORGANIZER_EMAILS = {x.strip().lower() for x in os.getenv("ORGANIZER_EMAILS", "").split(",") if x.strip()}
INVITE_CODE = os.getenv("INVITE_CODE", "").strip()
COMPETITION_TIMEZONE = os.getenv("COMPETITION_TIMEZONE", "Europe/Madrid")
