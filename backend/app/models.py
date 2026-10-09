"""PostgreSQL relational persistence for pilots, circuits and GPS timing."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    DateTime, ForeignKey, Integer, String, Boolean, Text, CheckConstraint,
    UniqueConstraint, Index, Float
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

class Circuit(Base):
    __tablename__ = "circuits"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    reference_points: Mapped[list] = mapped_column(JSONB, nullable=False)
    gate_radius_m: Mapped[int] = mapped_column(Integer, nullable=False, default=18)
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
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    __table_args__=(CheckConstraint("format IN ('gpx','tcx')", name="activity_format"),)

class Attempt(Base):
    __tablename__ = "training_attempts"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pilot_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("pilots.id", ondelete="CASCADE"), nullable=False, index=True)
    circuit_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("circuits.id", ondelete="CASCADE"), nullable=False, index=True)
    activity_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("gps_activities.id", ondelete="SET NULL"))
    source_filename: Mapped[str | None] = mapped_column(String(200))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    confidence: Mapped[float | None] = mapped_column(Float)
    gps_status: Mapped[str] = mapped_column(String(12), nullable=False, default="review")
    notes: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    splits: Mapped[list["AttemptSplit"]] = relationship(cascade="all, delete-orphan", order_by="AttemptSplit.sort_order", passive_deletes=True)
    __table_args__=(
        CheckConstraint("elapsed_ms >= 0 OR elapsed_ms IS NULL", name="attempt_elapsed_positive"),
        CheckConstraint("confidence BETWEEN 0 AND 1 OR confidence IS NULL", name="attempt_confidence"),
        CheckConstraint("gps_status IN ('review','compatible')", name="attempt_status"),
    )

class AttemptSplit(Base):
    __tablename__ = "attempt_splits"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("training_attempts.id", ondelete="CASCADE"), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    __table_args__=(UniqueConstraint("attempt_id","sort_order"),)
