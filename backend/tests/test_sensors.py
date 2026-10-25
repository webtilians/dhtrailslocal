"""The phone's sensors recorded with a ride: the app's «DHS1» file, kept next to the ride's GPS file."""
import gzip
import struct
import tracemalloc
import zlib

import pytest
from fastapi.testclient import TestClient

from app import config, sensors
from app.main import app
from test_competition import account, fixes, gpx, organizer, recent, upload  # noqa: F401 (fixture)


def dhs(seconds=3, hz=100, barometer=True, start=1792800000000.0):
    """A recording as the app writes it: motion at `hz`, the barometer at 10 Hz."""
    out = bytearray(struct.pack("<4sB3xd", b"DHS1", 1, start))
    for k in range(seconds * hz):
        t = round(k * 1000 / hz)
        out += b"\x01" + struct.pack("<I6h", t, 12, -981, 35, 100, -20, 5)
        if barometer and k % (hz // 10) == 0:
            out += b"\x02" + struct.pack("<If", t, 1001.25 - k * 0.001)
    return bytes(out)


def test_a_recording_is_read_whatever_its_compression():
    raw = dhs()
    deflate = zlib.compressobj(wbits=-zlib.MAX_WBITS)
    for data in (raw, gzip.compress(raw), deflate.compress(raw) + deflate.flush()):
        data = sensors.read(sensors.decode(data))
        assert data["start_ms"] == 1792800000000.0
        assert len(data["motion"]) == 300 and len(data["pressure"]) == 30
        t, ax, ay, az, gx, gy, gz = data["motion"][1]
        assert (t, ax, ay, az, gx, gy, gz) == (10, 0.12, -9.81, 0.35, 0.1, -0.02, 0.005)
        assert abs(data["pressure"][0][1] - 1001.25) < 1e-3
    info = sensors.summary(raw)
    assert info["seconds"] == 2.99 or abs(info["seconds"] - 3) < 0.05
    assert info["barometer"] and 99 <= info["motion_hz"] <= 101


def test_a_broken_or_foreign_file_is_refused():
    for bad in (b"", b"hello", gzip.compress(b"not ours"), dhs()[:-3], dhs().replace(b"DHS1", b"DHS2", 1)):
        with pytest.raises(sensors.SensorError):
            sensors.read(sensors.decode(bad))
        with pytest.raises(sensors.SensorError):
            sensors.summary(sensors.decode(bad))


def test_a_long_ride_is_summed_up_without_keeping_its_readings():
    # Half an hour at 100 Hz (180,000 readings). Kept as Python numbers they took tens of MB; a three-hour
    # ride took the server past its 400 MB on 25/10/2026.
    raw = dhs(seconds=1800)
    tracemalloc.start()
    info = sensors.summary(raw)
    peak = tracemalloc.get_traced_memory()[1]
    tracemalloc.stop()
    assert info["motion"] == 180000 and info["pressure"] == 18000 and abs(info["seconds"] - 1800) < 0.1
    assert peak < 1024 * 1024, peak


def test_the_sensors_go_with_their_ride_and_only_its_owner_sends_or_reads_them(organizer):
    with TestClient(app) as client:
        rider, other = account(client), account(client)
        route = upload(client, rider, "/api/training/routes", gpx(fixes(recent(30), 1000)), "grabada.gpx")
        assert route.status_code == 201, route.text
        rid = route.json()["activity"]["id"]
        send = lambda who, data: client.post(f"/api/training/routes/{rid}/sensors", headers=who,
                                             files={"file": ("sensores.dhs", data, "application/octet-stream")})
        assert send(other, gzip.compress(dhs())).status_code == 404
        assert send(rider, b"rubbish").status_code == 422
        r = send(rider, gzip.compress(dhs(barometer=False)))
        assert r.status_code == 200, r.text
        assert r.json()["sensors"]["motion"] == 300 and not r.json()["sensors"]["barometer"]
        listed = next(x for x in client.get("/api/training/routes", headers=rider).json() if x["id"] == rid)
        assert listed["sensors"]["motion"] == 300
        assert client.get(f"/api/training/routes/{rid}/sensors", headers=other).status_code == 404
        back = client.get(f"/api/training/routes/{rid}/sensors", headers=rider)
        assert back.status_code == 200 and sensors.decode(back.content) == dhs(barometer=False)
        stored = next((config.GPS_STORAGE_DIR).glob(f"*/{rid}.sensores"))
        assert client.delete(f"/api/training/routes/{rid}", headers=rider).status_code == 204
        assert not stored.exists()


def test_sensors_left_on_the_phone_find_their_route_by_time(organizer):
    # An upload that failed (the server fell over) left the sensors on the phone, without their route: sent
    # again, they go with the route that starts within 10 minutes of them.
    with TestClient(app) as client:
        rider = account(client)
        t0 = recent(40)
        route = upload(client, rider, "/api/training/routes", gpx(fixes(t0, 1000)), "larga.gpx")
        assert route.status_code == 201, route.text
        rid = route.json()["activity"]["id"]
        send = lambda data: client.post("/api/training/sensors", headers=rider,
                                        files={"file": ("sensores.dhs", gzip.compress(data), "application/octet-stream")})
        assert send(dhs(start=t0 - 3 * 3600 * 1000)).status_code == 404
        late = send(dhs(start=t0 + 4000))
        assert late.status_code == 200, late.text
        assert late.json()["route_id"] == rid and late.json()["filename"] == "larga.gpx"
        assert client.get(f"/api/training/routes/{rid}/sensors", headers=rider).status_code == 200
        # Someone else's route is never theirs.
        assert client.post("/api/training/sensors", headers=account(client),
                           files={"file": ("s.dhs", gzip.compress(dhs(start=t0 + 4000)), "application/octet-stream")}).status_code == 404
