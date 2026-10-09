"""Runtime settings; development defaults never expose a secret or DB externally."""
import os
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

def require_secret() -> str:
    if len(SECRET_KEY) < 32 or SECRET_KEY.startswith("CHANGE_ME"):
        raise RuntimeError("Configura un SECRET_KEY aleatorio de 32+ caracteres en backend/.env")
    return SECRET_KEY
