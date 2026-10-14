// DH Trails v0.8 — telemetry from run profiles, pure functions (tested in Node).
// A profile is [[metres along the circuit, ms since the start, lat, lon], ...] from the start
// line to the finish line, one entry per reliable GPS fix (see timing.py).

// Locate chart distances on the official circuit, including between GPS vertices.
export function circuitPosition(points, distances, metres) {
  if (!points.length || !Number.isFinite(metres)) return null;
  const s = Math.max(0, Math.min(distances.at(-1), metres));
  for (let i = 1; i < points.length; i++) {
    const span = distances[i] - distances[i - 1];
    if (span <= 0 || distances[i] < s) continue;
    const f = (s - distances[i - 1]) / span;
    return [0, 1].map(k => points[i - 1][k] + f * (points[i][k] - points[i - 1][k]));
  }
  return points.at(-1).slice(0, 2);
}

// The circuit line between two distances, to paint a stretch of it on the map.
export function circuitStretch(points, distances, from, to) {
  const inside = points.filter((_, i) => distances[i] > from && distances[i] < to).map(p => p.slice(0, 2));
  return [circuitPosition(points, distances, from), ...inside, circuitPosition(points, distances, to)];
}

// Time when the rider first reached position s. GPS jitter can step back a little:
// a position only counts once it goes beyond everything reached before.
export function timeAt(profile, s) {
  let reach = profile[0][0], time = profile[0][1];
  if (s <= reach) return time;
  for (let i = 1; i < profile.length; i++) {
    const [ps, pt] = profile[i];
    if (ps <= reach) continue;
    if (ps >= s) return time + (pt - time) * (s - reach) / (ps - reach);
    reach = ps; time = pt;
  }
  return profile.at(-1)[1];
}
// The run at fixed distances: every `step` metres plus the finish.
export function resample(profile, step = 10) {
  const length = profile.at(-1)[0], out = [];
  for (let s = 0; s < length; s += step) out.push({s, t: timeAt(profile, s)});
  out.push({s: length, t: profile.at(-1)[1]});
  return out;
}
// Speed in km/h around each sample, over `window` samples on each side (smooths 1 s GPS).
export function speedSeries(samples, window = 2) {
  return samples.map((p, i) => {
    const a = samples[Math.max(0, i - window)], b = samples[Math.min(samples.length - 1, i + window)];
    return {s: p.s, kmh: b.t > a.t ? (b.s - a.s) / (b.t - a.t) * 3600 : null};
  });
}
// Time lost (+) or gained (−) against a reference run at the same distances, in ms.
export function gapSeries(samples, reference) {
  const ref = reference.map(r => [r.s, r.t]);
  return samples.map(p => ({s: p.s, ms: p.t - timeAt(ref, p.s)}));
}
// Time of each segment between the gates (metres along the circuit), in ms.
export function segmentTimes(profile, gatesAt) {
  const marks = [0, ...gatesAt, profile.at(-1)[0]].map(s => timeAt(profile, s));
  return marks.slice(1).map((t, i) => t - marks[i]);
}
// Where a run slows down (braking). One GPS fix per second shows where and how much the speed
// drops over tens of metres, not the bite of the brakes: a zone goes from a speed peak to the next
// low point when the speed falls at least `minDropKmh` at `minDecel` m/s² or more on average.
// The speed is unknown where GPS is not reliable: a gap of more than `maxGapMs` between fixes or a
// jump no bike makes (faster than `maxSpeed` m/s). Such a stretch shows an average speed, not
// the real one, so a zone never starts or ends next to it.
export function brakingZones(profile, {step = 10, minDropKmh = 5, minDecel = 0.2, resumeKmh = 3,
                                      maxGapMs = 3000, maxSpeed = 22} = {}) {
  const samples = resample(profile, step), window = 2;
  const blind = [];
  for (let i = 1; i < profile.length; i++) {
    const [s0, t0] = profile[i - 1], [s1, t1] = profile[i];
    if (t1 - t0 > maxGapMs || (s1 - s0) * 1000 > maxSpeed * (t1 - t0)) blind.push([s0, s1]);
  }
  const reach = window * step;
  const kmh = speedSeries(samples, window).map(p =>
    blind.some(([a, b]) => p.s >= a - reach && p.s <= b + reach) ? null : p.kmh);

  const zones = [];
  const finish = (peak, low) => {
    if (peak === null || low === null || kmh[peak - 1] === null || kmh[low + 1] === null) return;
    const drop = kmh[peak] - kmh[low];
    if (drop < minDropKmh) return;
    // Trim the flat top and bottom: the zone is where the speed actually falls.
    let a = peak, b;
    while (a + 1 < low && kmh[a + 1] >= kmh[peak] - drop / 10) a++;
    for (b = a; b < low && kmh[b] > kmh[low] + drop / 10;) b++;
    const seconds = (samples[b].t - samples[a].t) / 1000;
    const decel = (kmh[a] - kmh[b]) / 3.6 / seconds;
    if (seconds > 0 && decel >= minDecel)
      zones.push({from: samples[a].s, to: samples[b].s, fromKmh: kmh[a], toKmh: kmh[b], seconds, decel});
  };
  let peak = null, low = null;
  for (let i = 0; i <= kmh.length; i++) {
    const v = i < kmh.length ? kmh[i] : null;
    if (v === null) { finish(peak, low); peak = low = null; }
    else if (peak === null || v >= kmh[peak]) { finish(peak, low); peak = i; low = null; }
    else if (low === null || v < kmh[low]) low = i;
    else if (v - kmh[low] >= resumeKmh) { finish(peak, low); peak = i; low = null; }
  }
  return zones;
}

// The braking of one or two runs, corner by corner. Two zones that end within `joinM` metres are
// the same corner (closest ends pair first); where only one run brakes, the other's zone is null.
// Each point also has the time every run takes through it, from `marginM` before the first zone
// to `marginM` after the last, so the faster way through a corner shows.
export function brakingPoints(profiles, {joinM = 35, marginM = 20} = {}) {
  const zones = profiles.map(p => brakingZones(p));
  const points = [];
  if (zones.length === 2) {
    const [a, b] = zones, usedA = new Set(), usedB = new Set();
    const close = a.flatMap((x, i) => b.map((y, j) => [Math.abs(x.to - y.to), i, j])).filter(([d]) => d <= joinM);
    for (const [, i, j] of close.sort((p, q) => p[0] - q[0]))
      if (!usedA.has(i) && !usedB.has(j)) {usedA.add(i); usedB.add(j); points.push([a[i], b[j]]);}
    a.forEach((x, i) => usedA.has(i) || points.push([x, null]));
    b.forEach((y, j) => usedB.has(j) || points.push([null, y]));
  } else points.push(...zones.flatMap((list, k) => list.map(z => profiles.map((_, n) => n === k ? z : null))));
  const end = Math.min(...profiles.map(p => p.at(-1)[0]));
  return points.map(pair => {
    const found = pair.filter(Boolean);
    const from = Math.max(0, Math.min(...found.map(z => z.from)) - marginM);
    const to = Math.min(end, Math.max(...found.map(z => z.to)) + marginM);
    return {from, to, zones: pair, ms: profiles.map(p => timeAt(p, to) - timeAt(p, from))};
  }).sort((p, q) => p.from - q.from);
}
