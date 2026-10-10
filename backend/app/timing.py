"""Server-side GPS timing, a port of gps-engine.mjs (parseGps + detectAttempts).

Ranked competition times are computed here from the uploaded GPX/TCX, never
taken from the browser. Keep the rules identical to the JavaScript engine so a
rider sees the same estimate in the editor and in the monthly ranking.
"""
import math
from bisect import bisect_right
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
    """Passes within radius of gate: (closest index, its distance, first index of the pass)."""
    groups, best = [], None
    for i in range(start, until + 1):
        d = haversine(route[i], gate)
        if d <= radius:
            if best is None:
                best = [i, d, i]
            elif d < best[1]:
                best[0], best[1] = i, d
        elif best is not None:
            groups.append(tuple(best))
            best = None
    if best is not None:
        groups.append(tuple(best))
    return groups

# Runs are followed by their position along the reference line (metres from the start). A gate
# is crossed when that position passes it, even if GPS error puts the fix tens of metres to one
# side. The search only looks a little ahead, so the lower leg of a switchback is not confused
# with the upper one; when the local match is poor it looks further ahead to recover.
START_RADIUS_M = 35      # fixes this close to the start begin a candidate run
MATCH_CORRIDOR_M = 60    # farther than this from the line, a fix does not move the rider
OFF_COURSE_M = 30        # separation that counts as leaving the drawn line
RECOVER_AHEAD_M = 400    # look-ahead when the local match is poor (e.g. a stop drawn into the reference)
MAX_SPEED_MS = 25        # forward search per second of recording (90 km/h)
BACKTRACK_M = 50         # the position going back this much along the course needs a review
BLIND_MS = 10000         # a gate crossed inside a longer GPS gap has no reliable time
LOST_MS = 300000         # five minutes without matching ends a candidate run
MAX_RUN_MS = 3600000     # nobody needs an hour for one run

def _along_track(pts, d, p, start, end):
    """(position along the line, lateral distance); negative before the start, beyond the length after the finish."""
    last = len(pts) - 2
    sx, sy = 111195 * math.cos(p.lat * math.pi / 180), 111195
    best = None
    i = max(0, bisect_right(d, start) - 1)
    while i <= last and d[i] <= end:
        a, b = pts[i], pts[i + 1]
        ax, ay = (a[1] - p.lon) * sx, (a[0] - p.lat) * sy
        dx, dy = (b[1] - a[1]) * sx, (b[0] - a[0]) * sy
        denom = dx * dx + dy * dy
        u = -(ax * dx + ay * dy) / denom if denom else 0
        if not (i == 0 and u < 0) and not (i == last and u > 1):
            u = max(0, min(1, u))
        lateral = math.hypot(ax + u * dx, ay + u * dy)
        if best is None or lateral < best[1]:
            best = (d[i] + u * (d[i + 1] - d[i]), lateral)
        i += 1
    return best

def _crossing_at(route, a, b, s):
    f = 1 if b[1] == a[1] else (s - a[1]) / (b[1] - a[1])
    ta, tb = route[a[0]].time, route[b[0]].time
    timed = _finite(ta) and _finite(tb) and tb >= ta
    # Interpolating across a long blind stretch would invent the split: the gate stays unknown.
    blind = timed and tb - ta > BLIND_MS
    return {"k": a[0] if f < 0.5 else b[0], "time": ta + (tb - ta) * f if timed and not blind else None, "blind": blind}

def _elapsed_ms(route, a, b):
    ta, tb = route[a].time, route[b].time
    return tb - ta if _finite(ta) and _finite(tb) else (b - a) * 1000

def _follow_run(route, pts, d, gates_at, first):
    length = d[-1]
    prev = start = finish = None
    gates, track, peak, backtrack, last_seen = {}, [], -math.inf, 0.0, first
    for k in range(first, len(route)):
        if _elapsed_ms(route, last_seen, k) > LOST_MS or _elapsed_ms(route, first, k) > MAX_RUN_MS:
            break
        p = route[k]
        if prev is None:
            m = _along_track(pts, d, p, -math.inf, min(length, 60))
        else:
            seconds = max(1, _elapsed_ms(route, prev[0], k) / 1000)
            m = _along_track(pts, d, p, prev[1] - 30, prev[1] + max(40, MAX_SPEED_MS * seconds))
            if m is None or m[1] > OFF_COURSE_M:
                wide = _along_track(pts, d, p, prev[1], prev[1] + RECOVER_AHEAD_M)
                if wide is not None and (m is None or wide[1] < m[1]):
                    m = wide
        if m is None or m[1] > MATCH_CORRIDOR_M:
            continue
        cur = (k, m[0], m[1])
        last_seen = k
        if prev is None:
            # The first fix is already past the start line: the start time is taken from it.
            if cur[1] >= 0:
                start = {"k": k, "time": p.time if _finite(p.time) else None, "blind": False, "estimated": cur[1]}
        elif prev[1] < 0 <= cur[1]:
            # Crossing the start line (again) restarts the run: waiting or riding back up is not timed.
            start = {**_crossing_at(route, prev, cur, 0), "estimated": 0}
            gates, track, peak, backtrack = {}, [], -math.inf, 0.0
        if start is not None:
            track.append(cur)
            if prev is not None:
                for i, g in enumerate(gates_at):
                    if i not in gates and prev[1] < g <= cur[1]:
                        gates[i] = _crossing_at(route, prev, cur, g)
                if prev[1] < length <= cur[1]:
                    finish = _crossing_at(route, prev, cur, length)
                    break
            peak = max(peak, cur[1])
            backtrack = max(backtrack, peak - cur[1])
        prev = cur
    if start is None or finish is None:
        return None
    return {"start": start, "finish": finish, "gates": [gates.get(i) for i in range(len(gates_at))],
            "track": track, "backtrack": backtrack}

def _off_course_stretch(track):
    """Longest stretch ridden more than OFF_COURSE_M from the line: [from_s, to_s, max_lateral]."""
    worst = current = None
    for _, s, lateral in track:
        if lateral <= OFF_COURSE_M:
            if current and (worst is None or current[1] - current[0] > worst[1] - worst[0]):
                worst = current
            current = None
        elif current is None:
            current = [s, s, lateral]
        else:
            current[1], current[2] = s, max(current[2], lateral)
    if current and (worst is None or current[1] - current[0] > worst[1] - worst[0]):
        worst = current
    return worst if worst and worst[1] - worst[0] >= 50 else None

def _whole(x: float) -> int:
    return math.floor(x + 0.5)  # like JavaScript Math.round, so both engines write the same texts

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
    gate_indices: list[int | None]

def detect_attempts(route: list[Fix], circuit: dict, radius: float | None = None) -> list[DetectedAttempt]:
    ref = circuit.get("points") or []
    if not route or not ref:
        return []
    d_ref = distance_series(ref)
    radius = radius if radius is not None else circuit.get("gateRadius") or 18
    gates_at = [d_ref[s["index"]] for s in circuit.get("sectors") or []]
    start_point = (ref[0][0], ref[0][1])
    weak = circuit.get("weakZones") or []
    results, cursor = [], 0
    for _, _, first in _gate_groups(route, start_point, 0, len(route) - 1, max(radius, START_RADIUS_M)):
        if first < cursor:
            continue
        run = _follow_run(route, ref, d_ref, gates_at, first)
        if run is None:
            continue
        start, finish = run["start"], run["finish"]
        i0, i1 = start["k"], finish["k"]
        if _finite(start["time"]) and _finite(finish["time"]) and finish["time"] - start["time"] < 12000:
            continue
        times = [start["time"], *[g["time"] if g else None for g in run["gates"]], finish["time"]]
        missing = sum(1 for g in run["gates"] if g is None or g["blind"])
        splits = [(v - times[i]) / 1000 if v is not None and times[i] is not None and v >= times[i] else None
                  for i, v in enumerate(times[1:])]
        outside = poor_zone = sampled = gaps = 0
        stride = max(1, math.ceil((i1 - i0) / 180))
        for k in range(i0, i1 + 1, stride):
            meters, ref_index = _proximity(route[k], ref)
            sampled += 1
            if meters > 30:
                outside += 1
                if any(z["from"] <= ref_index <= z["to"] for z in weak):
                    poor_zone += 1
        for k in range(i0 + 1, i1 + 1):
            if _finite(route[k].time) and _finite(route[k - 1].time) and route[k].time - route[k - 1].time > 5000:
                gaps += 1
        confidence = 1 - outside / sampled if sampled else 0
        away = _off_course_stretch(run["track"])
        timed = _finite(times[0]) and _finite(times[-1])
        ok = (missing == 0 and confidence >= 0.86 and not away and run["backtrack"] <= BACKTRACK_M
              and poor_zone == 0 and gaps == 0 and timed and start["estimated"] <= 5)
        issues = []
        if missing: issues.append(f"{missing} puerta(s) de sector sin datos GPS fiables")
        if confidence < 0.86: issues.append("la traza se separa del circuito")
        if away: issues.append(f"te separas hasta {_whole(away[2])} m del trazado entre el km {away[0] / 1000:.2f} y el {away[1] / 1000:.2f}")
        if run["backtrack"] > BACKTRACK_M: issues.append(f"el GPS retrocede {_whole(run['backtrack'])} m por el recorrido")
        if poor_zone: issues.append("desviaciones en zona GPS débil conocida")
        if gaps: issues.append(f"{gaps} intervalo(s) sin datos de más de 5 s")
        if start["estimated"] > 5: issues.append("la salida no aparece en el GPS: tiempo de salida aproximado")
        if not timed: issues.append("no hay marcas de tiempo completas")
        seconds = (times[-1] - times[0]) / 1000 if timed and times[-1] >= times[0] else None
        results.append(DetectedAttempt(i0, i1, times[0] if timed else None, seconds, splits, confidence, missing,
                                       issues, "compatible" if ok else "revisar",
                                       [i0, *[g["k"] if g else None for g in run["gates"]], i1]))
        cursor = i1 + 1
    return results

def best_attempt(attempts: list[DetectedAttempt]) -> DetectedAttempt | None:
    """Fastest compatible run; otherwise the fastest timed run, which then needs review."""
    timed = [a for a in attempts if a.seconds is not None]
    compatible = [a for a in timed if a.status == "compatible"]
    pool = compatible or timed
    return min(pool, key=lambda a: a.seconds) if pool else None
