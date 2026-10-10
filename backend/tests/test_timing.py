"""The server engine must reproduce the scenarios of tests/gps-engine.test.mjs."""
import math
from datetime import datetime, timezone

import pytest

from app.timing import Fix, GpsError, best_attempt, detect_attempts, parse_gps

ORIGIN = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000

def route(t0=ORIGIN, step=2000, without_time=False):
    return [Fix(36.74 - i * 0.000061, -4.45 + math.sin(i / 11) * 0.000094, 430 - i * 1.3,
                None if without_time else t0 + i * step) for i in range(100)]

def circuit():
    # Same circuit as buildCircuit('Santa Cruz', ref, 10, 87, gates 28/62, weak 41-50) in the JS tests.
    ref = route()[10:88]
    return {"points": [[round(p.lat, 7), round(p.lon, 7), p.ele] for p in ref],
            "sectors": [{"index": 18, "name": "Curvas"}, {"index": 52, "name": "Rock garden"}],
            "weakZones": [{"from": 31, "to": 40, "name": "Sombra GPS"}], "gateRadius": 18}

def gpx(fixes):
    points = "".join(
        f'<trkpt lat="{p.lat}" lon="{p.lon}"><ele>{p.ele}</ele>'
        f'<time>{datetime.fromtimestamp(p.time / 1000, timezone.utc).isoformat().replace("+00:00", "Z")}</time></trkpt>'
        for p in fixes)
    return f'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>{points}</trkseg></trk></gpx>'.encode()

def test_finds_the_run_and_ordered_sector_splits():
    attempts = detect_attempts(route(), circuit())
    assert len(attempts) == 1
    assert abs(attempts[0].seconds - 154) < 1.1
    assert len(attempts[0].splits) == 3 and all(s > 0 for s in attempts[0].splits)
    assert attempts[0].status == "compatible"

def test_finds_two_runs_and_picks_the_fastest():
    attempts = detect_attempts(route(ORIGIN, 2000) + route(ORIGIN + 500000, 1700), circuit())
    assert len(attempts) == 2
    assert attempts[1].seconds < attempts[0].seconds
    assert best_attempt(attempts) is attempts[1]

def test_no_timestamps_means_no_time():
    attempts = detect_attempts(route(without_time=True), circuit())
    assert len(attempts) == 1
    assert attempts[0].seconds is None and attempts[0].status == "revisar"
    assert best_attempt(attempts) is None

def test_distant_activity_is_not_a_run():
    far = [Fix(p.lat + 0.05, p.lon, p.ele, p.time) for p in route()]
    assert detect_attempts(far, circuit()) == []

def test_losing_gps_for_15_s_at_a_believable_speed_keeps_the_run():
    broken = [Fix(p.lat, p.lon, p.ele, p.time + 15000 if i >= 48 else p.time) for i, p in enumerate(route())]
    result = detect_attempts(broken, circuit())
    assert len(result) == 1 and result[0].status == "compatible"
    assert abs(result[0].seconds - 169) < 1.1
    assert any(note.startswith("GPS perdido o desviado 17 s") for note in result[0].notes)

def test_a_shortcut_while_the_gps_is_lost_is_flagged_by_its_speed():
    r = route()
    # Points 51-69 never recorded and point 70 reached 6 s after point 50: 136 m at 82 km/h.
    cut = r[:51] + [Fix(p.lat, p.lon, p.ele, p.time - 32000) for p in r[70:]]
    run = detect_attempts(cut, circuit())[0]
    assert run.status == "revisar"
    assert any("¿atajo o fallo del GPS?" in issue for issue in run.issues)

def test_gpx_round_trip_keeps_times():
    fixes = parse_gps(gpx(route()), "gpx")
    assert len(fixes) == 100 and fixes[0].time == ORIGIN
    assert abs(detect_attempts(fixes, circuit())[0].seconds - 154) < 1.1

def test_tcx_is_read():
    tcx = (b'<TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2">'
           b'<Activities><Activity><Lap><Track>'
           b'<Trackpoint><Time>2026-10-09T12:00:00Z</Time><Position><LatitudeDegrees>36.74</LatitudeDegrees>'
           b'<LongitudeDegrees>-4.45</LongitudeDegrees></Position><AltitudeMeters>430</AltitudeMeters></Trackpoint>'
           b'<Trackpoint><Time>2026-10-09T12:00:02.500+00:00</Time><Position><LatitudeDegrees>36.7399</LatitudeDegrees>'
           b'<LongitudeDegrees>-4.4501</LongitudeDegrees></Position></Trackpoint>'
           b'</Track></Lap></Activity></Activities></TrainingCenterDatabase>')
    fixes = parse_gps(tcx, "tcx")
    assert [f.ele for f in fixes] == [430, None]
    assert fixes[1].time - fixes[0].time == 2500

@pytest.mark.parametrize("data,ext", [
    (b"<gpx><trk>", "gpx"),
    (b'<gpx><trk><trkseg><trkpt lat="36" lon="-4"/></trkseg></trk></gpx>', "gpx"),
    (b"<gpx></gpx>", "tcx"),
])
def test_rejects_invalid_files(data, ext):
    with pytest.raises(GpsError):
        parse_gps(data, ext)

# Gates follow the position along the circuit, not a radius around one point.
def east_degrees(metres):
    return metres / (111195 * math.cos(math.radians(36.74)))

def test_gate_passed_with_gps_35_m_aside_is_timed_at_the_stretch_speed():
    shifted = [Fix(p.lat, p.lon + east_degrees(35), p.ele, p.time) if 55 <= i <= 69 else p for i, p in enumerate(route())]
    run = detect_attempts(shifted, circuit())[0]
    assert abs(run.seconds - 154) < 1.1
    assert run.missing == 0 and abs(run.splits[1] - 68) < 1.5
    assert run.status == "compatible"
    assert any("parciales estimados" in note for note in run.notes)

def test_waiting_at_the_start_line_is_not_timed():
    r = route()
    # Rolling back and forth over the line for a minute; the last position is behind it.
    wait = [Fix(r[10].lat + (-0.00002 if j % 2 == 0 else 0.00002), r[10].lon, r[10].ele, r[10].time + j * 2000) for j in range(30)]
    later = [Fix(p.lat, p.lon, p.ele, p.time + 60000) for p in r[10:]]
    runs = detect_attempts(r[:10] + wait + later, circuit())
    assert len(runs) == 1 and abs(runs[0].seconds - 154) < 1.1
