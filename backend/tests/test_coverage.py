"""How well the GPS times a circuit's start and finish, from the runs stored (app/coverage.py)."""
import math

from fastapi.testclient import TestClient

from app import coverage
from app.main import app
from test_competition import account, circuit_body, fixes, gpx, new_circuit, organizer, recent, upload  # noqa: F401 (fixture)

M = 1 / 111195                       # degrees of latitude per metre
EAST = 1 / (111195 * math.cos(math.radians(36.7)))
LINE = [[36.7 - i * 5 * M, -4.4] for i in range(61)]   # 300 m due south


def run(east, speed=8.0, lat_shift=0.0):
    """A run down the line at `speed` m/s, a fix a second, `east(metres down)` metres to the east of it."""
    return [[speed * t, t * 1000, 36.7 - speed * t * M + lat_shift, -4.4 + east(speed * t) * EAST] for t in range(int(300 / speed) + 1)]


def runs_of(*groups):
    """Runs (circuit, [profile, ...]) as the server stores them, each its own GPS file."""
    entries, n = [], 0
    for circuit, profiles in groups:
        for profile in profiles:
            n += 1
            entries.append((f"file-{n}", circuit, 1792800000000 + n * 3600000, profile))
    return entries


def test_a_finish_where_the_gps_strays_is_told_apart_from_a_clean_start():
    # Five runs: within a metre or two of the line at the start, 15-25 m off it by the finish.
    stray = [run(lambda s, k=k: 1 + k * 0.3 + (0 if s < 200 else 15 + 2 * k)) for k in range(5)]
    runs = coverage.Runs(runs_of(("A", stray)), {"A": LINE})
    got = coverage.circuit_coverage(runs, LINE, "A")
    assert got["start"]["level"] == "buena" and got["start"]["runs"] == 5 and got["start"]["error_s"] < 0.3, got["start"]
    assert got["finish"]["level"] == "mala" and got["finish"]["off_m"] > 15 and got["finish"]["error_s"] > 1.5, got["finish"]


def test_only_runs_on_the_same_trail_count_and_the_ride_the_line_came_from_does_not():
    good = [run(lambda s, k=k: 0.8 + 0.2 * k) for k in range(3)]
    # Another circuit's trail 30 m to the east (its runs pass within 40 m of the gates), and the very ride
    # this circuit was drawn from, on its line to the centimetre.
    beside = [[p[0], p[1]] for p in LINE]
    beside = [[lat, lon + 30 * EAST] for lat, lon in beside]
    other = [run(lambda s: 31) for _ in range(4)]
    drawn = [run(lambda s: 0)]
    runs = coverage.Runs(runs_of(("A", good + drawn), ("B", other)), {"A": LINE, "B": beside})
    got = coverage.circuit_coverage(runs, LINE, "A")
    assert got["start"]["runs"] == 3 and got["start"]["level"] == "buena", got["start"]
    # A new circuit on the same line, not saved yet: the same three runs.
    assert coverage.circuit_coverage(runs, LINE)["finish"]["runs"] == 3


def test_a_circuits_own_runs_come_first_and_too_few_give_no_verdict():
    own = [run(lambda s, k=k: 12 + k) for k in range(3)]                 # its own riders go 12-14 m off
    shared = [run(lambda s, k=k: 1 + 0.1 * k) for k in range(6)]         # another circuit on the same trail
    runs = coverage.Runs(runs_of(("A", own), ("C", shared)), {"A": LINE, "C": LINE})
    assert coverage.circuit_coverage(runs, LINE, "A")["finish"]["runs"] == 3
    assert coverage.circuit_coverage(runs, LINE, "A")["finish"]["off_m"] >= 12
    # With only two of its own, the trail's runs count too.
    runs = coverage.Runs(runs_of(("A", own[:2]), ("C", shared)), {"A": LINE, "C": LINE})
    assert coverage.circuit_coverage(runs, LINE, "A")["finish"]["runs"] == 8
    few = coverage.Runs(runs_of(("A", own[:2])), {"A": LINE})
    assert coverage.circuit_coverage(few, LINE, "A")["start"]["level"] is None
    assert coverage.circuit_coverage(coverage.Runs([], {}), LINE) == {"start": None, "finish": None}


def test_a_gate_where_the_gps_is_lost_counts_the_seconds_without_it():
    lost = [[p for p in run(lambda s, k=k: 1 + 0.2 * k) if not 270 <= p[0] < 296] for k in range(3)]
    got = coverage.circuit_coverage(coverage.Runs(runs_of(("A", lost)), {"A": LINE}), LINE, "A")["finish"]
    assert got["lost"] == 3 and got["error_s"] >= 1, got


def test_the_circuits_list_and_the_editor_say_how_well_the_gps_covers_start_and_finish(organizer):
    with TestClient(app) as client:
        org = account(client, email=organizer)
        rider = account(client)
        shift = 0.2 + hash(organizer) % 1000 * 0.003
        cid = new_circuit(client, org, "Cobertura", shift)
        for minutes in (90, 70, 50):
            assert upload(client, rider, "/api/training/routes", gpx(fixes(recent(minutes), 1000, shift))).status_code == 201
        listed = next(c for c in client.get("/api/circuits", headers=org).json() if c["id"] == cid)
        assert listed["coverage"]["start"]["runs"] >= 3 and listed["coverage"]["start"]["level"] in ("buena", "regular", "mala")
        line = [p[:2] for p in circuit_body("x", shift)["points"]]
        drawing = client.post("/api/circuits/coverage", headers=rider, json={"points": line})
        assert drawing.status_code == 200 and drawing.json()["finish"]["runs"] >= 3, drawing.text
        assert client.post("/api/circuits/coverage", json={"points": line}).status_code == 401
        assert client.post("/api/circuits/coverage", headers=rider, json={"points": [[95, 0], [0, 0]]}).status_code == 422
        # Leave no circuit behind: other tests look for empty ground at random.
        assert client.delete(f"/api/circuits/{cid}", headers=org).status_code == 204
