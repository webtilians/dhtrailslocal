"""Which circuits a rider may add: not one that already exists.

A circuit is the same as a saved one when both have their start and their finish within 30 m of each
other, or when each follows the other's line for at least 85 % of its length (the same trail drawn from
another route). A stretch of a longer circuit (a training sector) is not a repeat.
"""
from .timing import distance_series, haversine

SAME_ENDS_M = 30
ON_LINE_M = 15
SHARED = 0.85

def _sample(points, every=10.0):
    """Points of a line every `every` metres, to compare lines quickly."""
    d = distance_series(points)
    out, next_at = [], 0.0
    for p, m in zip(points, d):
        if m >= next_at:
            out.append(p)
            next_at = m + every
    return out

def _share_on(line, other) -> float:
    """Share of `line` that runs within ON_LINE_M of `other`."""
    sample = _sample(line)
    if not sample:
        return 0.0
    lat_pad, lon_pad = 0.002, 0.0025
    near = 0
    for p in sample:
        if any(abs(q[0] - p[0]) < lat_pad and abs(q[1] - p[1]) < lon_pad and haversine(p, q) <= ON_LINE_M for q in other):
            near += 1
    return near / len(sample)

def same_circuit(points, other) -> bool:
    if haversine(points[0], other[0]) <= SAME_ENDS_M and haversine(points[-1], other[-1]) <= SAME_ENDS_M:
        return True
    return _share_on(points, other) >= SHARED and _share_on(other, points) >= SHARED

def repeated(points, circuits):
    """The first saved circuit that is the same as this line, or None."""
    return next((c for c in circuits if same_circuit(points, c.reference_points)), None)
