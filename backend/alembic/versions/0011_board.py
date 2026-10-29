"""The board: riders' 🔥 and comments on its posts, comments reported to the organization, and riders
who block each other.

Revision ID: 0011
Revises: 0010
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0011"
down_revision="0010"
branch_labels=None
depends_on=None

def upgrade():
    uid=lambda name,target,**kw:sa.Column(name,postgresql.UUID(as_uuid=True),sa.ForeignKey(target,ondelete="CASCADE"),nullable=False,**kw)
    op.create_table("feed_reactions",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("post_key",sa.String(120),nullable=False),
        uid("pilot_id","pilots.id"),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.UniqueConstraint("post_key","pilot_id"))
    op.create_index("ix_feed_reactions_post_key","feed_reactions",["post_key"])
    op.create_table("feed_comments",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("post_key",sa.String(120),nullable=False),
        uid("pilot_id","pilots.id"),
        sa.Column("text",sa.String(300),nullable=False),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False))
    op.create_index("ix_feed_comments_post_key","feed_comments",["post_key"])
    op.create_index("ix_feed_comments_pilot_id","feed_comments",["pilot_id"])
    op.create_table("feed_reports",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        uid("comment_id","feed_comments.id"),
        uid("reporter_id","pilots.id"),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.UniqueConstraint("comment_id","reporter_id"))
    op.create_index("ix_feed_reports_comment_id","feed_reports",["comment_id"])
    op.create_table("pilot_blocks",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        uid("blocker_id","pilots.id"),
        uid("blocked_id","pilots.id"),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.UniqueConstraint("blocker_id","blocked_id"),
        sa.CheckConstraint("blocker_id <> blocked_id",name="block_not_self"))
    op.create_index("ix_pilot_blocks_blocker_id","pilot_blocks",["blocker_id"])
    op.create_index("ix_pilot_blocks_blocked_id","pilot_blocks",["blocked_id"])

def downgrade():
    op.drop_table("pilot_blocks")
    op.drop_table("feed_reports")
    op.drop_table("feed_comments")
    op.drop_table("feed_reactions")
