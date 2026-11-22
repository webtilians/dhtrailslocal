"""Groups: riders out together see each other on a map, with the group's guides, its shuttle drivers and its
meeting points; each rider's last shared location.

Revision ID: 0012
Revises: 0011
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision="0012"
down_revision="0011"
branch_labels=None
depends_on=None

def upgrade():
    uuid=postgresql.UUID(as_uuid=True)
    pilot=lambda name,**kw:sa.Column(name,uuid,sa.ForeignKey("pilots.id",ondelete="CASCADE"),nullable=False,**kw)
    when=lambda name,nullable=False:sa.Column(name,sa.DateTime(timezone=True),nullable=nullable)
    op.create_table("ride_groups",
        sa.Column("id",uuid,primary_key=True),
        sa.Column("name",sa.String(60),nullable=False),
        pilot("owner_id"),
        when("created_at"))
    op.create_index("ix_ride_groups_owner_id","ride_groups",["owner_id"])
    op.create_table("group_members",
        sa.Column("id",uuid,primary_key=True),
        sa.Column("group_id",uuid,sa.ForeignKey("ride_groups.id",ondelete="CASCADE"),nullable=False),
        pilot("pilot_id"),
        sa.Column("invited_by",uuid,sa.ForeignKey("pilots.id",ondelete="SET NULL")),
        when("accepted_at",nullable=True),
        sa.Column("sharing",sa.Boolean,nullable=False,server_default=sa.text("false")),
        sa.Column("role",sa.String(10)),
        when("created_at"),
        sa.UniqueConstraint("group_id","pilot_id"),
        sa.CheckConstraint("role IN ('guide','shuttle') OR role IS NULL",name="group_member_role"))
    op.create_index("ix_group_members_pilot_id","group_members",["pilot_id"])
    op.create_table("pilot_locations",
        pilot("pilot_id",primary_key=True),
        sa.Column("lat",sa.Float,nullable=False),
        sa.Column("lon",sa.Float,nullable=False),
        sa.Column("ele",sa.Float),
        sa.Column("accuracy_m",sa.Float),
        sa.Column("speed",sa.Float),
        when("updated_at"))
    op.create_index("ix_pilot_locations_updated_at","pilot_locations",["updated_at"])
    op.create_table("group_points",
        sa.Column("id",uuid,primary_key=True),
        sa.Column("group_id",uuid,sa.ForeignKey("ride_groups.id",ondelete="CASCADE"),nullable=False),
        sa.Column("created_by",uuid,sa.ForeignKey("pilots.id",ondelete="SET NULL")),
        sa.Column("name",sa.String(60),nullable=False),
        sa.Column("lat",sa.Float,nullable=False),
        sa.Column("lon",sa.Float,nullable=False),
        when("created_at"))
    op.create_index("ix_group_points_group_id","group_points",["group_id"])

def downgrade():
    op.drop_table("group_points")
    op.drop_table("pilot_locations")
    op.drop_table("group_members")
    op.drop_table("ride_groups")
