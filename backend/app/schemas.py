"""Shared API validation. The client can submit GPS estimates, never official results."""
from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

class Credentials(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8,max_length=128)

class SectorIn(BaseModel):
    index: int = Field(ge=1)
    name: str = Field(min_length=1,max_length=70)

class ZoneIn(BaseModel):
    model_config=ConfigDict(populate_by_name=True)
    from_index: int = Field(ge=0,alias="from")
    to: int = Field(ge=1)
    name: str = Field(min_length=1,max_length=70)

class CircuitIn(BaseModel):
    name: str = Field(min_length=1,max_length=100)
    points: list[list[float | None]] = Field(min_length=16,max_length=12000)
    sectors: list[SectorIn] = Field(default_factory=list,max_length=100)
    weakZones: list[ZoneIn] = Field(default_factory=list,max_length=100)
    gateRadius: int = Field(default=18,ge=3,le=80)

    @field_validator("points")
    @classmethod
    def coordinates(cls,value):
        from math import isfinite
        for p in value:
            if len(p)<2 or len(p)>3 or p[0] is None or p[1] is None:
                raise ValueError("Cada punto requiere latitud y longitud")
            if not (isfinite(p[0]) and isfinite(p[1]) and -90<=p[0]<=90 and -180<=p[1]<=180):
                raise ValueError("Coordenada GPS fuera de rango")
            if len(p)==3 and p[2] is not None and (not isfinite(p[2]) or abs(p[2])>12000):
                raise ValueError("Altitud GPS inválida")
        return value

    @model_validator(mode="after")
    def ordered_gates(self):
        if not self.name.strip():raise ValueError("Escribe el nombre")
        indices=[s.index for s in self.sectors]
        if indices!=sorted(set(indices)) or any(i>=len(self.points)-1 for i in indices):
            raise ValueError("Los límites de los sectores deben estar ordenados y dentro del circuito")
        for z in self.weakZones:
            if z.to<=z.from_index or z.to>=len(self.points):
                raise ValueError("Zona de cobertura GPS fuera del circuito")
        return self

class AttemptIn(BaseModel):
    circuit_id: UUID
    activity_id: UUID | None = None
    source_filename: str | None = Field(default=None,max_length=200)
    started_at: datetime | None = None
    elapsed_ms: int | None = Field(default=None,ge=0)
    sector_splits_ms: list[int | None] = Field(default_factory=list,max_length=101)
    confidence: float | None = Field(default=None,ge=0,le=1)
    gps_status: Literal["review","compatible"]="review"
    notes: str | None = Field(default=None,max_length=500)

    @field_validator("sector_splits_ms")
    @classmethod
    def nonnegative(cls,v):
        if any(x is not None and x<0 for x in v):
            raise ValueError("Tiempo de sector negativo")
        return v
