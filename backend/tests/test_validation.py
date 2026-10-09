from __future__ import annotations
import pytest
from pydantic import ValidationError
from app.schemas import CircuitIn, AttemptIn

def track(n=20):
    return [[36.7 + i*0.0001,-4.4 - i*0.0001,300-i] for i in range(n)]

def test_circuit_with_manual_sectors_and_weak_zone():
    c=CircuitIn(name="Santa Cruz",points=track(),sectors=[
      {"index":5,"name":"Curvas"},{"index":11,"name":"Pedregal"}
    ],weakZones=[{"from":12,"to":15,"name":"Bosque"}])
    assert c.sectors[1].index==11
    assert c.weakZones[0].from_index==12

@pytest.mark.parametrize("sectors",[
    [{"index":6,"name":"A"},{"index":5,"name":"B"}],
    [{"index":6,"name":"A"},{"index":6,"name":"B"}],
    [{"index":20,"name":"Fuera"}],
])
def test_reject_out_of_order_sectors(sectors):
    with pytest.raises(ValidationError):
        CircuitIn(name="Santa Cruz",points=track(),sectors=sectors)

def test_reject_invalid_gps():
    with pytest.raises(ValidationError):
        CircuitIn(name="Invalido",points=[[100,-4,0]]*20)

def test_reject_zone_outside_finish():
    with pytest.raises(ValidationError):
        CircuitIn(name="Santa Cruz",points=track(),weakZones=[{"from":14,"to":25,"name":"Fuera"}])

def test_attempt_splits_reject_negative():
    with pytest.raises(ValidationError):
        AttemptIn(circuit_id="8cd7c6b4-7877-40b9-b521-012add479d00",sector_splits_ms=[2000,-1])

def test_api_requires_secret(monkeypatch):
    from app import config
    monkeypatch.setattr(config,"SECRET_KEY","CHANGE_ME_TO_A_LONG_RANDOM_SECRET")
    with pytest.raises(RuntimeError):
        config.require_secret()
