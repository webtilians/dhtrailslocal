"""Riders draw circuits too: they count for training at once and wait for the organization's approval
before a tournament can use them. The circuits saved until now were all drawn by organizers.

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa

revision="0008"
down_revision="0007"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("circuits",sa.Column("approved_at",sa.DateTime(timezone=True)))
    op.execute("UPDATE circuits SET approved_at = created_at")

def downgrade():
    op.drop_column("circuits","approved_at")
