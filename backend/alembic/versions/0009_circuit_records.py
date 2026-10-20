"""Circuit records: every rider's best run on each circuit, from training and time trials. A rider may
choose not to appear in them.

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa

revision="0009"
down_revision="0008"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("pilots",sa.Column("in_records",sa.Boolean(),nullable=False,server_default=sa.text("true")))

def downgrade():
    op.drop_column("pilots","in_records")
