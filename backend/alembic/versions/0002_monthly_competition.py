"""Monthly competition: rider names, published circuits, server-timed reviewed entries.

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

revision="0002"
down_revision="0001"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("pilots",sa.Column("display_name",sa.String(30)))
    op.create_unique_constraint("pilots_display_name_key","pilots",["display_name"])
    op.add_column("circuits",sa.Column("published_at",sa.DateTime(timezone=True)))
    op.add_column("gps_activities",sa.Column("sha256",sa.String(64)))
    op.create_index("ix_gps_activities_sha256","gps_activities",["sha256"])
    op.add_column("training_attempts",sa.Column("timed_by",sa.String(6),nullable=False,server_default="client"))
    op.add_column("training_attempts",sa.Column("review_status",sa.String(8)))
    op.add_column("training_attempts",sa.Column("review_note",sa.String(300)))
    op.add_column("training_attempts",sa.Column("reviewed_at",sa.DateTime(timezone=True)))
    op.create_check_constraint("attempt_timed_by","training_attempts","timed_by IN ('client','server')")
    op.create_check_constraint("attempt_review_status","training_attempts",
        "review_status IN ('pending','approved','rejected') OR review_status IS NULL")
    op.create_index("ix_training_attempts_ranking","training_attempts",["circuit_id","review_status"])

def downgrade():
    op.drop_index("ix_training_attempts_ranking","training_attempts")
    op.drop_constraint("attempt_review_status","training_attempts",type_="check")
    op.drop_constraint("attempt_timed_by","training_attempts",type_="check")
    for column in ("reviewed_at","review_note","review_status","timed_by"):
        op.drop_column("training_attempts",column)
    op.drop_index("ix_gps_activities_sha256","gps_activities")
    op.drop_column("gps_activities","sha256")
    op.drop_column("circuits","published_at")
    op.drop_constraint("pilots_display_name_key","pilots",type_="unique")
    op.drop_column("pilots","display_name")
