"""The phone's sensors recorded with a ride (accelerometer, gyroscope, barometer), kept next to its GPS file.

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0010"
down_revision="0009"
branch_labels=None
depends_on=None

def upgrade():
    op.add_column("gps_activities",sa.Column("sensors_name",sa.String(100),nullable=True))
    op.add_column("gps_activities",sa.Column("sensors_bytes",sa.Integer(),nullable=True))
    op.add_column("gps_activities",sa.Column("sensors_summary",postgresql.JSONB(),nullable=True))

def downgrade():
    op.drop_column("gps_activities","sensors_summary")
    op.drop_column("gps_activities","sensors_bytes")
    op.drop_column("gps_activities","sensors_name")
