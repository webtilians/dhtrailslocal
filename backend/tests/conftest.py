import pytest

from app import competition, main

@pytest.fixture(autouse=True)
def fresh_rate_limits():
    # Every TestClient request comes from the same address; start each test with clean counters.
    for limiter in (main.login_limit, main.register_limit, competition.entry_limit):
        limiter.reset()
    yield
