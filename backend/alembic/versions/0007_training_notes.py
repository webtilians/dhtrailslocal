"""A rider's notes at places of a circuit, for training.

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0007"
down_revision="0006"
branch_labels=None
depends_on=None

def upgrade():
    op.create_table("training_notes",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("pilot_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("circuit_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("circuits.id",ondelete="CASCADE"),nullable=False),
        sa.Column("attempt_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("training_attempts.id",ondelete="SET NULL")),
        sa.Column("metres",sa.Float(),nullable=False),
        sa.Column("text",sa.String(200),nullable=False),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("metres >= 0",name="note_metres"))
    op.create_index("ix_training_notes_pilot_circuit","training_notes",["pilot_id","circuit_id"])

def downgrade():
    op.drop_index("ix_training_notes_pilot_circuit",table_name="training_notes")
    op.drop_table("training_notes")
