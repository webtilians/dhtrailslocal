"""How well the GPS times a circuit's start or finish where it is, from the stored runs that pass that point.
The start and the finish decide a run's whole time; a gate in between only moves time from one sector to
the next.

A circuit's own runs say how it is ridden there; when it has fewer than three, the runs of other circuits
that follow the same trail through that point count too (their line within 10 m, going the same way):
another trail a few metres away says nothing about this one. For each run passing: how far its
fixes sit from the circuit's line there (GPS error shows sideways as much as along the trail), over its
speed through the gate, gives the seconds a crossing can be off; a run whose fixes are missing there (more
than 3 s between them) is off by about half the time without them. The ride a circuit was drawn from lies on
its line to the centimetre and is left out: it says nothing about the GPS there.
"""
import math
import statistics
from collections import defaultdict

PASS_MS = 4000        # a passage: the fixes from 4 s before to 4 s after the closest one to the gate
NEAR_M = 40           # a run passes the gate when one of its fixes is this close
SAME_TRAIL_M = 10     # another circuit's line this close to the gate, going the same way, is the same trail
SAME_WAY_DEG = 45
MIN_SPEED = 1.5       # m/s: slower than this (nearly stopped) counts as this
DRAWN_FROM_M = 0.3    # a passage this close to the line (median) is the ride the line was drawn from
MIN_RUNS = 3          # fewer passages than this say too little for a verdict
GOOD_S, FAIR_S = 0.5, 1.5
CELL = 0.0005         # degrees, ~50 m: the grid the fixes are found by

_R = 6371000 * math.pi / 180


def _xy(p, lat0):
    return p[1] * _R * math.cos(lat0 * math.pi / 180), p[0] * _R


def _metres(a, b):
    k = math.cos((a[0] + b[0]) / 2 * math.pi / 180)
    return math.hypot((b[1] - a[1]) * k, b[0] - a[0]) * _R


def _nearest_segment(p, line):
    """(metres from p to the line, direction of the line's nearest segment in degrees)."""
    px, py = _xy(p, p[0])
    best = (math.inf, 0)
    for a, b in zip(line, line[1:]):
        ax, ay = _xy(a, p[0]); bx, by = _xy(b, p[0])
        dx, dy = bx - ax, by - ay
        denom = dx * dx + dy * dy
        u = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / denom)) if denom else 0
        d = math.hypot(ax + u * dx - px, ay + u * dy - py)
        if d < best[0]:
            best = (d, math.degrees(math.atan2(dy, dx)))
    return best


def _same_way(a, b):
    return abs((a - b + 180) % 360 - 180) <= SAME_WAY_DEG


class Runs:
    """The stored runs' fixes, found by place, and the lines of their circuits. `entries`: (the GPS file's id,
    the run's circuit, its start in ms since 1970, its profile [[metres, ms from the start, lat, lon, ...]]);
    `lines`: {circuit: [[lat, lon, ...]]}. One ride timed on two circuits that share a gate, or in training
    and in a tournament, passes it once."""

    def __init__(self, entries, lines):
        self.keys, self.circuits, self.runs = [], [], []
        for key, circuit, started_ms, profile in entries:
            if profile and len(profile) >= 3:
                self.keys.append(key)
                self.circuits.append(circuit)
                self.runs.append([(p[2], p[3], started_ms + p[1]) for p in profile])
        self.lines = {c: [(p[0], p[1]) for p in points] for c, points in lines.items() if points and len(points) >= 2}
        self.grid = defaultdict(list)
        for r, run in enumerate(self.runs):
            for i, (lat, lon, _) in enumerate(run):
                self.grid[(int(lat // CELL), int(lon // CELL))].append((r, i))

    def near(self, at):
        """For each run with a fix within NEAR_M of `at`: (run, index of its closest fix)."""
        ci, cj = int(at[0] // CELL), int(at[1] // CELL)
        closest = {}
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for r, i in self.grid.get((ci + di, cj + dj), ()):
                    d = _metres(at, self.runs[r][i])
                    if d <= NEAR_M and (r not in closest or d < closest[r][0]):
                        closest[r] = (d, i)
        return [(r, i) for r, (_, i) in closest.items()]


def gate_coverage(runs: Runs, line, at, own=None):
    """At point `at` ([lat, lon]) of a circuit (`own`, when saved) whose `line` around it is [[lat, lon], ...]: the runs passing,
    the seconds a crossing there is typically off and at worst (the worst tenth with ten runs or more), how
    far from the line and how fast they pass, how many lose their fixes there, and a level ('buena',
    'regular', 'mala'; None with fewer than MIN_RUNS runs). None when no run passes."""
    way = _nearest_segment(at, line)[1]
    same_trail = {own}
    for c, other in runs.lines.items():
        d, heading = _nearest_segment(at, other)
        if d <= SAME_TRAIL_M and _same_way(heading, way):
            same_trail.add(c)
    seen, passed = [], set()
    for r, k in runs.near(at):
        if runs.circuits[r] not in same_trail:
            continue
        run = runs.runs[r]
        t = run[k][2]
        if (runs.keys[r], round(t / 1000)) in passed:
            continue
        passed.add((runs.keys[r], round(t / 1000)))
        window = [p for p in run if abs(p[2] - t) <= PASS_MS]
        off = statistics.median(_nearest_segment(p, line)[0] for p in window)
        if off < DRAWN_FROM_M:
            continue
        span = (window[-1][2] - window[0][2]) / 1000
        speed = sum(_metres(a, b) for a, b in zip(window, window[1:])) / span if span > 0 else 0
        gap = max((run[i + 1][2] - run[i][2]) / 1000 for i in range(max(0, k - 1), min(len(run) - 1, k + 1)))
        seen.append((max(off / max(speed, MIN_SPEED), (gap - 1) / 2), off, speed, gap > 3, runs.circuits[r] == own))
    if own is not None and sum(s[4] for s in seen) >= MIN_RUNS:
        seen = [s for s in seen if s[4]]
    if not seen:
        return None
    errors = sorted(s[0] for s in seen)
    typical = statistics.median(errors)
    worst = errors[int(len(errors) * 0.9)] if len(errors) >= 10 else errors[-1]
    level = None if len(seen) < MIN_RUNS else \
        "buena" if typical <= GOOD_S and worst <= FAIR_S else "regular" if typical <= FAIR_S else "mala"
    return {"runs": len(seen), "error_s": round(typical, 2), "worst_s": round(worst, 2),
            "off_m": round(statistics.median(s[1] for s in seen), 1),
            "speed_kmh": round(statistics.median(s[2] for s in seen) * 3.6, 1), "lost": sum(s[3] for s in seen),
            "level": level}


def circuit_coverage(runs: Runs, points, own=None):
    """The start's and the finish's coverage of a circuit given by its line ([[lat, lon, ...]], start to finish)."""
    line = [(p[0], p[1]) for p in points]
    if len(line) < 2:
        return {"start": None, "finish": None}

    def around(i):
        lo, hi = i, i
        while lo > 0 and _metres(line[lo], line[i]) < 60:
            lo -= 1
        while hi < len(line) - 1 and _metres(line[hi], line[i]) < 60:
            hi += 1
        return line[lo:hi + 1]
    return {"start": gate_coverage(runs, around(0), line[0], own), "finish": gate_coverage(runs, around(len(line) - 1), line[-1], own)}
