"""The phone's sensors recorded with a ride (Grabar, in the app for Android and iPhone): the accelerometer and
the gyroscope about 100 times a second and, when the phone has one, the barometer. The app sends them in a
compact binary file, «DHS1», little-endian:

    "DHS1", version (1 byte), 3 bytes reserved, start (float64, ms since 1970 UTC)
    records, each one after a type byte:
      0x01 motion:   time (uint32, ms from the start), acceleration x, y, z (int16, 0.01 m/s², with gravity),
                     rotation x, y, z (int16, 0.001 rad/s)
      0x02 pressure: time (uint32, ms from the start), pressure (float32, hPa)

compressed with gzip (Android), raw deflate (iPhone) or not at all. Kept next to the ride's GPS file for the
analyses that read them (bumps, jumps, impacts, the barometer's height)."""
import struct
import zlib

MAX_UPLOAD = 40 * 1024 * 1024   # compressed: about 10 hours at 100 Hz
MAX_RAW = 250 * 1024 * 1024     # once decompressed (a file that grows past this is refused, not read)
MAGIC = b"DHS1"
_HEAD = struct.Struct("<4sB3xd")
_MOTION = struct.Struct("<I6h")
_PRESSURE = struct.Struct("<If")


class SensorError(ValueError):
    pass


def decode(data: bytes) -> bytes:
    """The file as recorded, whatever compression it came in."""
    if data[:4] == MAGIC:
        return data
    for wbits in (16 + zlib.MAX_WBITS, -zlib.MAX_WBITS, zlib.MAX_WBITS):   # gzip, raw deflate, zlib
        try:
            inflater = zlib.decompressobj(wbits)
            raw = inflater.decompress(data, MAX_RAW + 1)
        except zlib.error:
            continue
        if len(raw) > MAX_RAW or inflater.unconsumed_tail:
            raise SensorError("too big")
        if raw[:4] == MAGIC:
            return raw
    raise SensorError("not a sensors file")


def read(raw: bytes) -> dict:
    """start_ms, motion [(ms, ax, ay, az, gx, gy, gz)] in m/s² and rad/s, pressure [(ms, hPa)]."""
    if len(raw) < _HEAD.size:
        raise SensorError("short")
    magic, version, start = _HEAD.unpack_from(raw, 0)
    if magic != MAGIC or version != 1:
        raise SensorError("unknown version")
    motion, pressure = [], []
    pos = _HEAD.size
    while pos < len(raw):
        kind = raw[pos]
        pos += 1
        if kind == 1 and pos + _MOTION.size <= len(raw):
            t, ax, ay, az, gx, gy, gz = _MOTION.unpack_from(raw, pos)
            motion.append((t, ax / 100, ay / 100, az / 100, gx / 1000, gy / 1000, gz / 1000))
            pos += _MOTION.size
        elif kind == 2 and pos + _PRESSURE.size <= len(raw):
            pressure.append(_PRESSURE.unpack_from(raw, pos))
            pos += _PRESSURE.size
        else:
            raise SensorError("bad record")
    return {"start_ms": start, "motion": motion, "pressure": pressure}


def summary(raw: bytes) -> dict:
    """What a recording holds, to keep with its ride."""
    data = read(raw)
    motion, pressure = data["motion"], data["pressure"]
    times = [m[0] for m in motion] + [p[0] for p in pressure]
    seconds = (max(times) - min(times)) / 1000 if times else 0
    return {"start_ms": data["start_ms"], "seconds": round(seconds, 1), "motion": len(motion), "pressure": len(pressure),
            "motion_hz": round(len(motion) / seconds, 1) if seconds else 0, "barometer": bool(pressure)}
