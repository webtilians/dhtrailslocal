"""Local start: cd backend && python run.py

Requires a running PostgreSQL and a configured backend/.env.
Applies Alembic schema migrations before listening.
"""
from pathlib import Path
from alembic import command
from alembic.config import Config
import uvicorn

from app.config import API_HOST, API_PORT

if __name__=="__main__":
    cfg=Config(str(Path(__file__).resolve().parent/"alembic.ini"))
    command.upgrade(cfg,"head")
    uvicorn.run("app.main:app",host=API_HOST,port=API_PORT,reload=False)
