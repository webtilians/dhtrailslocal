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
#
# Trails are singletrack: a fix far from the line is GPS error or lost coverage, not another
# line. Crossings are timed only between reliable fixes, at the average speed of the stretch in
# between. A stretch without reliable GPS is accepted when that average speed is plausible next
# to the rider's own pace around it; only an impossible speed (a shortcut) needs a review.
START_RADIUS_M = 35      # fixes this close to the start begin a candidate run
MATCH_CORRIDOR_M = 60    # farther than this from the line, a fix does not move the rider
RELIABLE_M = 30          # fixes this close to the line time the gates
RECOVER_AHEAD_M = 400    # look-ahead when the local match is poor (e.g. a stop drawn into the reference)
MAX_SPEED_MS = 25        # forward search per second of recording (90 km/h)
BLIND_GAP_MS = 5000      # reliable fixes further apart than this leave a stretch to check
PACE_WINDOW_MS = 20000   # the rider's pace just before and just after a stretch
PACE_FACTOR = 1.6        # a stretch may be this much faster than that pace (plus 1 m/s)
MAX_PLAUSIBLE_MS = 22    # 80 km/h: faster than this on a DH trail is not believable
ENDPOINT_ERROR_M = 30    # the two reliable fixes around a stretch can each sit ~15 m off along the trail
FINISH_WAIT_MS = 30000   # after a drifting fix past the finish, wait this long for a reliable one
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

def _elapsed_ms(route, a, b):
    ta, tb = route[a].time, route[b].time
    return tb - ta if _finite(ta) and _finite(tb) else (b - a) * 1000

# A matched fix is (route index, position along the line, lateral distance); a pair is (a, b).
def _time_at(route, pair, s):
    """Time at position s between two reliable fixes, at the average speed between them."""
    a, b = pair
    ta, tb = route[a[0]].time, route[b[0]].time
    if not _finite(ta) or not _finite(tb) or tb < ta:
        return None
    f = 1 if b[1] == a[1] else max(0, min(1, (s - a[1]) / (b[1] - a[1])))
    return ta + (tb - ta) * f

def _nearest_index(pair, s):
    a, b = pair
    f = 1 if b[1] == a[1] else (s - a[1]) / (b[1] - a[1])
    return a[0] if f < 0.5 else b[0]

def _follow_run(route, pts, d, gates_at, first):
    length = d[-1]
    prev = good = start = finish = pending = None
    gates, track, last_seen = {}, [], first
    for k in range(first, len(route)):
        if _elapsed_ms(route, last_seen, k) > LOST_MS or _elapsed_ms(route, first, k) > MAX_RUN_MS:
            break
        if pending and _elapsed_ms(route, pending[1][0], k) > FINISH_WAIT_MS:
            break
        p = route[k]
        if prev is None:
            m = _along_track(pts, d, p, -math.inf, min(length, 60))
        else:
            seconds = max(1, _elapsed_ms(route, prev[0], k) / 1000)
            m = _along_track(pts, d, p, prev[1] - 30, prev[1] + max(40, MAX_SPEED_MS * seconds))
            if m is None or m[1] > RELIABLE_M:
                wide = _along_track(pts, d, p, prev[1], prev[1] + RECOVER_AHEAD_M)
                if wide is not None and (m is None or wide[1] < m[1]):
                    m = wide
        if m is None or m[1] > MATCH_CORRIDOR_M:
            continue
        cur = (k, m[0], m[1])
        prev = cur
        last_seen = k
        if cur[2] > RELIABLE_M:
            # A drifting fix still moves the search on; crossings wait for a reliable one.
            if start and good and not pending and good[1] < length <= cur[1]:
                pending = (good, cur)
            continue
        if good is None:
            # The first reliable fix is already past the start line: the start is estimated from it.
            if cur[1] >= 0:
                start, track = (None, cur), [cur]
        elif good[1] < 0 <= cur[1]:
            # Crossing the start line (again) restarts the run: waiting or riding back up is not timed.
            start, gates, track, pending = (good, cur), {}, [cur], None
        elif start:
            track.append(cur)
            for i, g in enumerate(gates_at):
                if i not in gates and good[1] < g <= cur[1]:
                    gates[i] = (good, cur)
            if good[1] < length <= cur[1]:
                finish = (good, cur)
                break
        good = cur
    if finish is None and pending:
        finish = pending
        track.append(pending[1])
    if start is None or finish is None:
        return None
    for i, g in enumerate(gates_at):
        if i not in gates and finish[0][1] < g <= finish[1][1]:
            gates[i] = finish
    return {"start": start, "finish": finish, "gates": [gates.get(i) for i in range(len(gates_at))], "track": track}

def _start_time(route, start, track):
    """A start estimated from the first reliable fix goes back at the pace of the next seconds."""
    if start[0] is not None:
        return _time_at(route, start, 0)
    b = start[1]
    tb = route[b[0]].time
    if not _finite(tb):
        return None
    later = next((f for f in track if _finite(route[f[0]].time) and route[f[0]].time - tb >= 5000), None)
    pace = (later[1] - b[1]) / ((route[later[0]].time - tb) / 1000) if later else 0
    return tb - b[1] / pace * 1000 if pace > 0.5 else tb

def _pace_between(route, a, b):
    ta, tb = route[a[0]].time, route[b[0]].time
    return (b[1] - a[1]) / ((tb - ta) / 1000) if _finite(ta) and _finite(tb) and tb - ta >= 1000 else None

def _blind_stretches(route, track, run_pace):
    """Stretches with no reliable GPS for over 5 s, and whether their average speed is believable."""
    out = []
    for i in range(1, len(track)):
        a, b = track[i - 1], track[i]
        ta, tb = route[a[0]].time, route[b[0]].time
        if not _finite(ta) or not _finite(tb) or tb - ta <= BLIND_GAP_MS:
            continue
        j = i - 1
        while j > 0 and _finite(route[track[j - 1][0]].time) and ta - route[track[j - 1][0]].time <= PACE_WINDOW_MS:
            j -= 1
        n = i
        while n < len(track) - 1 and _finite(route[track[n + 1][0]].time) and route[track[n + 1][0]].time - tb <= PACE_WINDOW_MS:
            n += 1
        around = [v for v in (_pace_between(route, track[j], a), _pace_between(route, b, track[n]), run_pace) if v is not None and v > 0]
        pace = max([0, *around])
        speed = (b[1] - a[1]) / ((tb - ta) / 1000)
        plausible = b[1] - a[1] < 15 or speed <= min(MAX_PLAUSIBLE_MS, PACE_FACTOR * pace + 1 + ENDPOINT_ERROR_M / ((tb - ta) / 1000))
        out.append({"from": a[1], "to": b[1], "seconds": (tb - ta) / 1000, "speed": speed, "plausible": plausible})
    return out

def _whole(x: float) -> int:
    return math.floor(x + 0.5)  # like JavaScript Math.round, so both engines write the same texts

def _km(metres: float) -> str:
    return f"{metres / 1000:.2f}"

@dataclass
class DetectedAttempt:
    start_index: int
    finish_index: int
    started_ms: float | None
    seconds: float | None
    splits: list[float | None]
    confidence: float
    missing: int
    issues: list[str]   # reasons for a review
    notes: list[str]    # information that does not affect the status
    status: str  # 'compatible' | 'revisar'
    gate_indices: list[int | None]

def detect_attempts(route: list[Fix], circuit: dict, radius: float | None = None) -> list[DetectedAttempt]:
    ref = circuit.get("points") or []
    if not route or not ref:
        return []
    d_ref = distance_series(ref)
    length = d_ref[-1]
    radius = radius if radius is not None else circuit.get("gateRadius") or 18
    gates_at = [d_ref[s["index"]] for s in circuit.get("sectors") or []]
    start_point = (ref[0][0], ref[0][1])
    results, cursor = [], 0
    for _, _, first in _gate_groups(route, start_point, 0, len(route) - 1, max(radius, START_RADIUS_M)):
        if first < cursor:
            continue
        run = _follow_run(route, ref, d_ref, gates_at, first)
        if run is None:
            continue
        start, finish, track = run["start"], run["finish"], run["track"]
        i0 = _nearest_index(start, 0) if start[0] is not None else start[1][0]
        i1 = _nearest_index(finish, length)
        times = [_start_time(route, start, track),
                 *[_time_at(route, g, gates_at[i]) if g else None for i, g in enumerate(run["gates"])],
                 _time_at(route, finish, length)]
        if _finite(times[0]) and _finite(times[-1]) and times[-1] - times[0] < 12000:
            continue
        missing = sum(1 for g in run["gates"] if g is None)
        splits = [(v - times[i]) / 1000 if v is not None and times[i] is not None and v >= times[i] else None
                  for i, v in enumerate(times[1:])]
        outside = sampled = 0
        stride = max(1, math.ceil((i1 - i0) / 180))
        for k in range(i0, i1 + 1, stride):
            sampled += 1
            if _proximity(route[k], ref)[0] > RELIABLE_M:
                outside += 1
        confidence = 1 - outside / sampled if sampled else 0
        timed = _finite(times[0]) and _finite(times[-1])
        seconds = (times[-1] - times[0]) / 1000 if timed and times[-1] >= times[0] else None
        stretches = _blind_stretches(route, track, length / seconds) if seconds else []
        doubtful = [x for x in stretches if not x["plausible"]]
        accepted = [x for x in stretches if x["plausible"]]
        estimated_start = 0 if start[0] is not None else start[1][1]
        ok = timed and missing == 0 and not doubtful and confidence >= 0.5 and estimated_start <= 20
        issues, notes = [], []
        if missing: issues.append(f"{missing} puerta(s) de sector sin datos GPS")
        for x in doubtful:
            issues.append(f"entre el km {_km(x['from'])} y el {_km(x['to'])} irías a {_whole(x['speed'] * 3.6)} km/h "
                          "de media sin GPS fiable: ¿atajo o fallo del GPS?")
        if confidence < 0.5: issues.append("el GPS se separa del trazado en más de la mitad de la bajada")
        if estimated_start > 20: issues.append("la salida no aparece en el GPS")
        if not timed: issues.append("no hay marcas de tiempo completas")
        if accepted:
            x = accepted[0]
            for y in accepted[1:]:
                if y["seconds"] > x["seconds"]:
                    x = y
            note = (f"GPS perdido o desviado {_whole(x['seconds'])} s entre el km {_km(x['from'])} y el {_km(x['to'])} "
                    f"a {_whole(x['speed'] * 3.6)} km/h de media, coherente")
            if len(accepted) > 1: note += f" (y {len(accepted) - 1} tramo(s) más)"
            if any(y["from"] < g <= y["to"] for g in gates_at for y in accepted): note += "; parciales estimados con esa velocidad"
            notes.append(note)
        if 5 < estimated_start <= 20:
            notes.append(f"salida estimada: el GPS empieza {_whole(estimated_start)} m después de la línea")
        results.append(DetectedAttempt(i0, i1, times[0] if timed else None, seconds, splits, confidence, missing,
                                       issues, notes, "compatible" if ok else "revisar",
                                       [i0, *[_nearest_index(g, gates_at[i]) if g else None for i, g in enumerate(run["gates"])], i1]))
        cursor = i1 + 1
    return results

def best_attempt(attempts: list[DetectedAttempt]) -> DetectedAttempt | None:
    """Fastest compatible run; otherwise the fastest timed run, which then needs review."""
    timed = [a for a in attempts if a.seconds is not None]
    compatible = [a for a in timed if a.status == "compatible"]
    pool = compatible or timed
    return min(pool, key=lambda a: a.seconds) if pool else None
