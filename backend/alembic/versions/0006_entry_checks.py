"""Time trial entries keep the signs of an edited or copied file and who reviewed them by hand.

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0006"
down_revision="0005"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("training_attempts",sa.Column("reviewed_by",postgresql.UUID(as_uuid=True),
        sa.ForeignKey("pilots.id",ondelete="SET NULL")))
    op.add_column("training_attempts",sa.Column("checks",postgresql.JSONB()))

def downgrade():
    op.drop_column("training_attempts","checks")
    op.drop_column("training_attempts","reviewed_by")
