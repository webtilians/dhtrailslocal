import pytest

from app import competition, friends, main, training

@pytest.fixture(autouse=True)
def fresh_rate_limits():
    # Every TestClient request comes from the same address; start each test with clean counters.
    for limiter in (main.login_limit, main.register_limit, main.circuit_limit, competition.entry_limit, training.route_limit, training.note_limit, friends.request_limit):
        limiter.reset()
    yield
