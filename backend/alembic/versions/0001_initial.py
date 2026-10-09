"""Initial relational tables: pilots, circuits, GPS activities, attempts.

Revision ID: 0001
Revises:
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0001"
down_revision=None
branch_labels=None
depends_on=None

def upgrade():
    op.create_table(
        "pilots",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("email",sa.String(254),nullable=False),
        sa.Column("password_hash",sa.Text(),nullable=False),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
    )
    # SQLAlchemy models email as a unique index (not an additional constraint).
    op.create_index("ix_pilots_email","pilots",["email"],unique=True)
    op.create_table(
        "circuits",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("owner_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("name",sa.String(100),nullable=False),
        sa.Column("reference_points",postgresql.JSONB(),nullable=False),
        sa.Column("gate_radius_m",sa.Integer(),nullable=False),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.Column("updated_at",sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("gate_radius_m BETWEEN 3 AND 80",name="circuit_gate_radius"),
    )
    op.create_index("ix_circuits_owner_id","circuits",["owner_id"])
    op.create_table(
        "circuit_sectors",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("circuit_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("circuits.id",ondelete="CASCADE"),nullable=False),
        sa.Column("sort_order",sa.Integer(),nullable=False),
        sa.Column("gate_index",sa.Integer(),nullable=False),
        sa.Column("name",sa.String(70),nullable=False),
        sa.UniqueConstraint("circuit_id","sort_order"),
        sa.UniqueConstraint("circuit_id","gate_index"),
    )
    op.create_table(
        "circuit_weak_zones",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("circuit_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("circuits.id",ondelete="CASCADE"),nullable=False),
        sa.Column("start_index",sa.Integer(),nullable=False),
        sa.Column("end_index",sa.Integer(),nullable=False),
        sa.Column("name",sa.String(70),nullable=False),
        sa.CheckConstraint("end_index > start_index",name="weak_zone_positive"),
    )
    op.create_table(
        "gps_activities",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("owner_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("filename",sa.String(200),nullable=False),
        sa.Column("storage_name",sa.String(100),nullable=False,unique=True),
        sa.Column("format",sa.String(3),nullable=False),
        sa.Column("file_bytes",sa.Integer(),nullable=False),
        sa.Column("gps_points",sa.Integer()),
        sa.Column("distance_m",sa.Float()),
        sa.Column("recorded_at",sa.DateTime(timezone=True)),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("format IN ('gpx','tcx')",name="activity_format"),
    )
    op.create_index("ix_gps_activities_owner_id","gps_activities",["owner_id"])
    op.create_table(
        "training_attempts",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("pilot_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False),
        sa.Column("circuit_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("circuits.id",ondelete="CASCADE"),nullable=False),
        sa.Column("activity_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("gps_activities.id",ondelete="SET NULL")),
        sa.Column("source_filename",sa.String(200)),
        sa.Column("started_at",sa.DateTime(timezone=True)),
        sa.Column("elapsed_ms",sa.Integer()),
        sa.Column("confidence",sa.Float()),
        sa.Column("gps_status",sa.String(12),nullable=False),
        sa.Column("notes",sa.String(500)),
        sa.Column("created_at",sa.DateTime(timezone=True),nullable=False),
        sa.CheckConstraint("elapsed_ms >= 0 OR elapsed_ms IS NULL",name="attempt_elapsed_positive"),
        sa.CheckConstraint("confidence BETWEEN 0 AND 1 OR confidence IS NULL",name="attempt_confidence"),
        sa.CheckConstraint("gps_status IN ('review','compatible')",name="attempt_status"),
    )
    op.create_index("ix_training_attempts_pilot_id","training_attempts",["pilot_id"])
    op.create_index("ix_training_attempts_circuit_id","training_attempts",["circuit_id"])
    op.create_table(
        "attempt_splits",
        sa.Column("id",postgresql.UUID(as_uuid=True),primary_key=True),
        sa.Column("attempt_id",postgresql.UUID(as_uuid=True),sa.ForeignKey("training_attempts.id",ondelete="CASCADE"),nullable=False),
        sa.Column("sort_order",sa.Integer(),nullable=False),
        sa.Column("elapsed_ms",sa.Integer()),
        sa.UniqueConstraint("attempt_id","sort_order"),
    )

def downgrade():
    for name in ["attempt_splits","training_attempts","gps_activities","circuit_weak_zones","circuit_sectors","circuits","pilots"]:
        op.drop_table(name)
