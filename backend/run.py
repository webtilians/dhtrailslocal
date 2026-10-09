"""Local start: cd backend && python run.py

Requires a running PostgreSQL and a configured backend/.env.
Applies Alembic schema migrations before listening.
"""
from pathlib import Path
from alembic import command
from alembic.config import Config
import uvicorn

if __name__=="__main__":
    cfg=Config(str(Path(__file__).resolve().parent/"alembic.ini"))
    command.upgrade(cfg,"head")
    uvicorn.run("app.main:app",host="127.0.0.1",port=8000,reload=False)
