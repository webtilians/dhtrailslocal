"""Friendships: riders who share their training runs with each other.

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0004"
down_revision="0003"
branch_labels=None
depends_on=None

def upgrade():
    op.create_table(
        "friendships",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("requester_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("addressee_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("accepted_at",sa.DateTime(timezone=True)),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.UniqueConstraint("requester_id","addressee_id"),
        sa.CheckConstraint("requester_id <> addressee_id",name="friendship_not_self"),
    )
    op.create_index("ix_friendships_addressee_id","friendships",["addressee_id"])

def downgrade():
    op.drop_index("ix_friendships_addressee_id","friendships")
    op.drop_table("friendships")
