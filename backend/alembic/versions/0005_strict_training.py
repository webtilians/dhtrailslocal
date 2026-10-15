"""Training keeps only runs that follow their circuit, as strictly as a time trial entry.

Revision ID: 0005
Revises: 0004
"""
from alembic import op

revision="0005"
down_revision="0004"
branch_labels=None
depends_on=None

def upgrade():
    # Before this rule, a route that passed a circuit's start and finish on another path (on the way
    # to other trails) was kept as a run of that circuit, with a start estimated hundreds of metres
    # away. Time trial entries are never touched; their splits go with them (ON DELETE CASCADE).
    op.execute("DELETE FROM training_attempts WHERE tournament_id IS NULL AND timed_by = 'server' "
               "AND review_status IS NULL AND (gps_status <> 'compatible' OR confidence IS NULL OR confidence < 0.85)")

def downgrade():
    # Nothing to restore: saving a circuit looks for it again in every uploaded route.
    pass
