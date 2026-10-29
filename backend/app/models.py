"""PostgreSQL relational persistence for pilots, circuits and GPS timing."""
import uuid
from datetime import datetime, timezone

from datetime import date

from sqlalchemy import (
    Date, DateTime, ForeignKey, Integer, String, Boolean, Text, CheckConstraint,
    UniqueConstraint, Index, Float, text
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .database import Base

def utcnow() -> datetime:
    return datetime.now(timezone.utc)

class Pilot(Base):
    __tablename__ = "pilots"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(254), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str | None] = mapped_column(String(30), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    # Whether the rider's best times appear in the circuit records (app.records).
    in_records: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default=text("true"))

class Circuit(Base):
    __tablename__ = "circuits"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    reference_points: Mapped[list] = mapped_column(JSONB, nullable=False)
    gate_radius_m: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
    # Set once by an organizer: the circuit joins the monthly competition and its gates are frozen.
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when the organization accepts it for tournaments. A rider's circuit counts for training at once.
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)
    sectors: Mapped[list["Sector"]] = relationship(back_populates="circuit", cascade="all, delete-orphan", order_by="Sector.sort_order", passive_deletes=True)
    weak_zones: Mapped[list["WeakZone"]] = relationship(back_populates="circuit", cascade="all, delete-orphan", order_by="WeakZone.start_index", passive_deletes=True)
    __table_args__=(CheckConstraint("gate_radius_m BETWEEN 3 AND 80", name="circuit_gate_radius"),)

class Sector(Base):
    __tablename__ = "circuit_sectors"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="CASCADE"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    gate_index: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(70), nullable=False)
    circuit: Mapped[Circuit] = relationship(back_populates="sectors")
    __table_args__=(UniqueConstraint("circuit_id","sort_order"),UniqueConstraint("circuit_id","gate_index"))

class WeakZone(Base):
    __tablename__ = "circuit_weak_zones"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="CASCADE"), nullable=False)
    start_index: Mapped[int] = mapped_column(Integer, nullable=False)
    end_index: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str] = mapped_column(String(70), nullable=False)
    circuit: Mapped[Circuit] = relationship(back_populates="weak_zones")
    __table_args__=(CheckConstraint("end_index > start_index", name="weak_zone_positive"),)

class Activity(Base):
    __tablename__ = "gps_activities"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(200), nullable=False)
    storage_name: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    format: Mapped[str] = mapped_column(String(3), nullable=False)
    file_bytes: Mapped[int] = mapped_column(Integer, nullable=False)
    gps_points: Mapped[int | None] = mapped_column(Integer, nullable=True)
    distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    recorded_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    # The phone's sensors recorded with the ride (app/sensors.py), next to the GPS file; what they hold.
    sensors_name: Mapped[str | None] = mapped_column(String(100))
    sensors_bytes: Mapped[int | None] = mapped_column(Integer)
    sensors_summary: Mapped[dict | None] = mapped_column(JSONB)
    __table_args__=(CheckConstraint("format IN ('gpx','tcx')", name="activity_format"),)

class Friendship(Base):
    """A friend request; once accepted, both riders can compare each other's training runs."""
    __tablename__ = "friendships"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requester_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False)
    addressee_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # NULL while pending
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(
        UniqueConstraint("requester_id", "addressee_id"),
        CheckConstraint("requester_id <> addressee_id", name="friendship_not_self"),
    )

class Tournament(Base):
    """A time trial on one circuit between two dates (local calendar days, both included)."""
    __tablename__ = "tournaments"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="RESTRICT"), nullable=False, index=True)
    starts_on: Mapped[date] = mapped_column(Date, nullable=False)
    ends_on: Mapped[date] = mapped_column(Date, nullable=False)
    # Share of the run that must follow the circuit line to enter the standings automatically.
    min_match: Mapped[float] = mapped_column(Float, nullable=False, default=0.85)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pilots.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    circuit: Mapped[Circuit] = relationship()
    __table_args__=(
        CheckConstraint("ends_on >= starts_on", name="tournament_dates"),
        CheckConstraint("min_match BETWEEN 0.5 AND 1", name="tournament_min_match"),
    )

class Attempt(Base):
    __tablename__ = "training_attempts"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pilot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="CASCADE"), nullable=False, index=True)
    activity_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("gps_activities.id", ondelete="SET NULL"))
    # Set for time trial entries; NULL for training runs.
    tournament_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("tournaments.id", ondelete="CASCADE"), index=True)
    source_filename: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    confidence: Mapped[float | None] = mapped_column(Float)
    gps_status: Mapped[str] = mapped_column(String(12), nullable=False, default="review")
    notes: Mapped[str | None] = mapped_column(String(500))
    # 'server' times come from the uploaded GPS file; only those can be ranked.
    timed_by: Mapped[str] = mapped_column(String(6), nullable=False, default="client", server_default="client")
    # NULL for private training; competition entries go pending -> approved/rejected.
    review_status: Mapped[str | None] = mapped_column(String(8))
    review_note: Mapped[str | None] = mapped_column(String(300))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Set when an organizer decided by hand (not the automatic filter).
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("pilots.id", ondelete="SET NULL"))
    # Signs of an edited or copied file (app.integrity), on time trial entries and training runs; NULL: not checked yet.
    checks: Mapped[list | None] = mapped_column(JSONB)
    # [metres along the circuit, ms since the start, lat, lon] per reliable fix (server-timed runs).
    profile: Mapped[list | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    splits: Mapped[list["AttemptSplit"]] = relationship(cascade="all, delete-orphan", order_by="AttemptSplit.sort_order", passive_deletes=True)
    __table_args__=(
        CheckConstraint("elapsed_ms >= 0 OR elapsed_ms IS NULL", name="attempt_elapsed_positive"),
        CheckConstraint("confidence BETWEEN 0 AND 1 OR confidence IS NULL", name="attempt_confidence"),
        CheckConstraint("gps_status IN ('review','compatible')", name="attempt_status"),
        CheckConstraint("timed_by IN ('client','server')", name="attempt_timed_by"),
        CheckConstraint("review_status IN ('pending','approved','rejected') OR review_status IS NULL", name="attempt_review_status"),
        Index("ix_training_attempts_ranking", "circuit_id", "review_status"),
    )

class TrainingNote(Base):
    """A rider's own note at a place of a circuit ("aquí freno tarde"), shown again on every run there."""
    __tablename__ = "training_notes"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pilot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="CASCADE"), nullable=False)
    # The run it was written on, if any (the note stays when that run goes).
    attempt_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("training_attempts.id", ondelete="SET NULL"))
    metres: Mapped[float] = mapped_column(Float, nullable=False)
    text: Mapped[str] = mapped_column(String(200), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(
        CheckConstraint("metres >= 0", name="note_metres"),
        Index("ix_training_notes_pilot_circuit", "pilot_id", "circuit_id"),
    )

class FeedReaction(Base):
    """A rider's 🔥 on a post of the board (app.feed). A post is named by its key, as the board makes it."""
    __tablename__ = "feed_reactions"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_key: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    pilot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(UniqueConstraint("post_key", "pilot_id"),)

class FeedComment(Base):
    """A comment on a post of the board: seen by whoever sees the post."""
    __tablename__ = "feed_comments"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    post_key: Mapped[str] = mapped_column(String(120), nullable=False, index=True)
    pilot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    text: Mapped[str] = mapped_column(String(300), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

class FeedReport(Base):
    """A rider reports a comment to the organization; they stop seeing it at once."""
    __tablename__ = "feed_reports"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    comment_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("feed_comments.id", ondelete="CASCADE"), nullable=False, index=True)
    reporter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(UniqueConstraint("comment_id", "reporter_id"),)

class PilotBlock(Base):
    """A rider blocks another: neither sees the other's posts or comments on the board any more."""
    __tablename__ = "pilot_blocks"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    blocker_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    blocked_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(
        UniqueConstraint("blocker_id", "blocked_id"),
        CheckConstraint("blocker_id <> blocked_id", name="block_not_self"),
    )

class AttemptSplit(Base):
    __tablename__ = "attempt_splits"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("training_attempts.id", ondelete="CASCADE"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    __table_args__=(UniqueConstraint("attempt_id","sort_order"),)
