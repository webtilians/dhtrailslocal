"""Server-side GPS timing, a port of gps-engine.mjs (parseGps + detectAttempts).

Ranked competition times are computed here from the uploaded GPX/TCX, never
taken from the browser. Keep the rules identical to the JavaScript engine so a
rider sees the same estimate in the editor and in the monthly ranking.
"""
import math
from dataclasses import dataclass
from datetime import datetime, timezone

from defusedxml.ElementTree import fromstring as safe_xml

MAX_POINTS = 80000

class GpsError(ValueError):
    pass

@dataclass(frozen=True)
class Fix:
    lat: float
    lon: float
    ele: float | None
    time: float | None  # epoch milliseconds

def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]

def _number(value):
    if value is None or not value.strip():
        return None
    try:
        n = float(value)
    except ValueError:
        return None
    return n if math.isfinite(n) else None

def _first_text(el, name):
    if el is None:
        return None
    for child in el.iter():
        if child is not el and _local(child.tag) == name:
            return (child.text or "").strip()
    return None

def _epoch_ms(value):
    if not value:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:  # GPX and TCX times are UTC by specification
        moment = moment.replace(tzinfo=timezone.utc)
    return moment.timestamp() * 1000

def parse_gps(data: bytes, extension: str) -> list[Fix]:
    try:
        root = safe_xml(data)
    except Exception as exc:
        raise GpsError("XML no válido.") from exc
    kind = extension.lower()
    name = _local(root.tag).lower()
    if not ((kind == "gpx" and name == "gpx") or (kind == "tcx" and name == "trainingcenterdatabase")):
        raise GpsError("El archivo no corresponde a GPX o TCX.")
    wanted = "trkpt" if kind == "gpx" else "Trackpoint"
    nodes = [el for el in root.iter() if _local(el.tag) == wanted]
    if not nodes and kind == "gpx":
        nodes = [el for el in root.iter() if _local(el.tag) == "rtept"]
    if len(nodes) > MAX_POINTS:
        raise GpsError("Archivo demasiado grande: máximo 80.000 puntos.")
    fixes = []
    for el in nodes:
        if kind == "gpx":
            lat, lon = _number(el.get("lat")), _number(el.get("lon"))
            ele, moment = _number(_first_text(el, "ele")), _first_text(el, "time")
        else:
            position = next((c for c in el.iter() if c is not el and _local(c.tag) == "Position"), None)
            lat = _number(_first_text(position, "LatitudeDegrees"))
            lon = _number(_first_text(position, "LongitudeDegrees"))
            ele, moment = _number(_first_text(el, "AltitudeMeters")), _first_text(el, "Time")
        if lat is None or lon is None or abs(lat) > 90 or abs(lon) > 180:
            continue
        fixes.append(Fix(lat, lon, ele, _epoch_ms(moment)))
    if len(fixes) < 2:
        raise GpsError("Necesitamos al menos dos puntos GPS válidos.")
    return fixes

def _latlon(p):
    return (p.lat, p.lon) if isinstance(p, Fix) else (p[0], p[1])

def haversine(a, b) -> float:
    (lat_a, lon_a), (lat_b, lon_b) = _latlon(a), _latlon(b)
    rad = math.pi / 180
    p, q = lat_a * rad, lat_b * rad
    dl, dp = (lon_b - lon_a) * rad, q - p
    h = math.sin(dp / 2) ** 2 + math.cos(p) * math.cos(q) * math.sin(dl / 2) ** 2
    return 6371000 * 2 * math.atan2(math.sqrt(h), math.sqrt(max(0, 1 - h)))

def distance_series(points) -> list[float]:
    cumulative = [0.0]
    for i in range(1, len(points)):
        cumulative.append(cumulative[-1] + haversine(points[i - 1], points[i]))
    return cumulative

def _finite(value) -> bool:
    return value is not None and math.isfinite(value)

# Projection of a GPS fix on one reference segment, using a small-area metric plane.
def _projected_distance(p: Fix, a, b) -> float:
    scale_x, scale_y = 111195 * math.cos(p.lat * math.pi / 180), 111195
    ax, ay = (a[1] - p.lon) * scale_x, (a[0] - p.lat) * scale_y
    bx, by = (b[1] - p.lon) * scale_x, (b[0] - p.lat) * scale_y
    dx, dy = bx - ax, by - ay
    denom = dx * dx + dy * dy
    u = max(0, min(1, -(ax * dx + ay * dy) / denom)) if denom else 0
    return math.hypot(ax + u * dx, ay + u * dy)

def _proximity(p: Fix, ref):
    best_m, best_i = math.inf, 0
    stride = max(1, math.ceil(len(ref) / 1800))
    for i in range(0, len(ref) - 1, stride):
        j = min(i + stride, len(ref) - 1)
        d = _projected_distance(p, ref[i], ref[j])
        if d < best_m:
            best_m, best_i = d, i
    return best_m, best_i

def _gate_groups(route, gate, start, until, radius):
    groups, best = [], None
    for i in range(start, until + 1):
        d = haversine(route[i], gate)
        if d <= radius:
            if best is None or d < best[1]:
                best = (i, d)
        elif best is not None:
            groups.append(best)
            best = None
    if best is not None:
        groups.append(best)
    return groups

# Approximate closest approach to gate, interpolated between consecutive timestamped fixes.
def _time_at_gate(route, index, gate):
    best_d = math.inf
    best_t = route[index].time if 0 <= index < len(route) else None
    glat, glon = gate
    for j in (index - 1, index):
        if j < 0 or j + 1 >= len(route):
            continue
        a, b = route[j], route[j + 1]
        if not _finite(a.time) or not _finite(b.time) or b.time < a.time:
            continue
        sx, sy = 111195 * math.cos(glat * math.pi / 180), 111195
        ax, ay = (a.lon - glon) * sx, (a.lat - glat) * sy
        dx, dy = (b.lon - a.lon) * sx, (b.lat - a.lat) * sy
        denom = dx * dx + dy * dy
        u = max(0, min(1, -(ax * dx + ay * dy) / denom)) if denom else 0
        distance = math.hypot(ax + u * dx, ay + u * dy)
        if distance < best_d:
            best_d, best_t = distance, a.time + (b.time - a.time) * u
    return best_t

@dataclass
class DetectedAttempt:
    start_index: int
    finish_index: int
    started_ms: float | None
    seconds: float | None
    splits: list[float | None]
    confidence: float
    missing: int
    issues: list[str]
    status: str  # 'compatible' | 'revisar'

def detect_attempts(route: list[Fix], circuit: dict, radius: float | None = None) -> list[DetectedAttempt]:
    ref = circuit.get("points") or []
    if not route or not ref:
        return []
    d_ref, d_user = distance_series(ref), distance_series(route)
    gates = [0, *[s["index"] for s in circuit.get("sectors") or []], len(ref) - 1]
    radius = radius if radius is not None else circuit.get("gateRadius") or 18
    start_gate, finish_gate = (ref[0][0], ref[0][1]), (ref[-1][0], ref[-1][1])
    weak = circuit.get("weakZones") or []
    results, cursor = [], 0
    for s_index, _ in _gate_groups(route, start_gate, 0, len(route) - 1, radius):
        if s_index < cursor:
            continue
        min_dist = max(35, d_ref[-1] * 0.55)
        end = None
        for f_index, _ in _gate_groups(route, finish_gate, min(len(route) - 1, s_index + 12), len(route) - 1, radius):
            t0, t1 = route[s_index].time, route[f_index].time
            if (f_index > s_index and d_user[f_index] - d_user[s_index] >= min_dist
                    and (not _finite(t0) or not _finite(t1) or t1 - t0 >= 12000)):
                end = f_index
                break
        if end is None:
            continue
        previous, missing = s_index, 0
        times = [_time_at_gate(route, s_index, start_gate)]
        for g in gates[1:-1]:
            point = (ref[g][0], ref[g][1])
            hits = _gate_groups(route, point, previous + 1, end - 1, radius)
            if not hits:
                times.append(None)
                missing += 1
                continue
            times.append(_time_at_gate(route, hits[0][0], point))
            previous = hits[0][0]
        end_time = _time_at_gate(route, end, finish_gate)
        times.append(end_time)
        splits = [(v - times[i]) / 1000 if v is not None and times[i] is not None and v >= times[i] else None
                  for i, v in enumerate(times[1:])]
        outside = poor_zone = sampled = gaps = 0
        stride = max(1, math.ceil((end - s_index) / 180))
        for k in range(s_index, end + 1, stride):
            meters, ref_index = _proximity(route[k], ref)
            sampled += 1
            if meters > 30:
                outside += 1
                if any(z["from"] <= ref_index <= z["to"] for z in weak):
                    poor_zone += 1
        for k in range(s_index + 1, end + 1):
            if _finite(route[k].time) and _finite(route[k - 1].time) and route[k].time - route[k - 1].time > 5000:
                gaps += 1
        confidence = 1 - outside / sampled if sampled else 0
        timed = _finite(times[0]) and _finite(end_time)
        ok = missing == 0 and confidence >= 0.86 and poor_zone == 0 and gaps == 0 and timed
        issues = []
        if missing: issues.append(f"{missing} puerta(s) de sector no detectadas")
        if confidence < 0.86: issues.append("la traza se separa del circuito")
        if poor_zone: issues.append("desviaciones en zona GPS débil conocida")
        if gaps: issues.append(f"{gaps} intervalo(s) sin datos de más de 5 s")
        if not timed: issues.append("no hay marcas de tiempo completas")
        seconds = (end_time - times[0]) / 1000 if timed and end_time >= times[0] else None
        results.append(DetectedAttempt(s_index, end, times[0] if _finite(times[0]) else None, seconds, splits,
                                       confidence, missing, issues, "compatible" if ok else "revisar"))
        cursor = end + 1
    return results

def best_attempt(attempts: list[DetectedAttempt]) -> DetectedAttempt | None:
    """Fastest compatible run; otherwise the fastest timed run, which then needs review."""
    timed = [a for a in attempts if a.seconds is not None]
    compatible = [a for a in timed if a.status == "compatible"]
    pool = compatible or timed
    return min(pool, key=lambda a: a.seconds) if pool else None
