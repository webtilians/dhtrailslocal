"""Tournaments (time trials between dates) and run profiles for training.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0003"
down_revision="0002"
branch_labels=None
depends_on=None

def upgrade():
    op.create_table(
        "tournaments",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("name",sa.String(100),nullable=False),
        sa.Column("circuit_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("circuits.id",ondelete="RESTRICT"),nullable=False),
        sa.Column("starts_on",sa.Date(),nullable=False),
        sa.Column("ends_on",sa.Date(),nullable=False),
        sa.Column("min_match",sa.Float(),nullable=False),
        sa.Column("created_by",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="SET NULL")),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("ends_on >= starts_on",name="tournament_dates"),
        sa.CheckConstraint("min_match BETWEEN 0.5 AND 1",name="tournament_min_match"),
    )
    op.create_index("ix_tournaments_circuit_id","tournaments",["circuit_id"])
    op.add_column("training_attempts",sa.Column("tournament_id",postgresql.UUID(as_uuid=True),
        sa.ForeignKey("tournaments.id",ondelete="CASCADE")))
    op.create_index("ix_training_attempts_tournament_id","training_attempts",["tournament_id"])
    op.add_column("training_attempts",sa.Column("profile",postgresql.JSONB()))

def downgrade():
    op.drop_column("training_attempts","profile")
    op.drop_index("ix_training_attempts_tournament_id","training_attempts")
    op.drop_column("training_attempts","tournament_id")
    op.drop_index("ix_tournaments_circuit_id","tournaments")
    op.drop_table("tournaments")
