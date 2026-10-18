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
// Where a run was this many ms after its start: distance along the circuit and its own GPS point
// (before the start, at the start; after the finish, at the finish).
export function positionAt(profile, ms) {
  let i = profile.findIndex(p => p[1] >= ms);
  if (i <= 0) i = i < 0 ? profile.length - 1 : 1;
  const a = profile[i - 1], b = profile[i];
  const f = b[1] > a[1] ? Math.min(1, Math.max(0, (ms - a[1]) / (b[1] - a[1]))) : 1;
  return {s: a[0] + f * (b[0] - a[0]), lat: a[2] + f * (b[2] - a[2]), lon: a[3] + f * (b[3] - a[3])};
}
// Time a run loses (+) or gains (−) against a reference stretch by stretch along the circuit, every
// `step` metres: where one day went slower than another, not just how far behind it ended up.
export function timeLost(profile, reference, step = 25) {
  const length = Math.min(profile.at(-1)[0], reference.at(-1)[0]), out = [];
  for (let from = 0; from < length; from += step) {
    const to = Math.min(length, from + step);
    out.push({from, to, ms: timeAt(profile, to) - timeAt(profile, from) - (timeAt(reference, to) - timeAt(reference, from))});
  }
  return out;
}
// Neighbouring stretches that all lose (or all gain) more than `noise` ms, joined into zones; the zones
// worth at least `min` ms, biggest first.
export function lossZones(stretches, {noise = 50, min = 300} = {}) {
  const zones = [];
  for (const x of stretches) {
    const sign = x.ms > noise ? 1 : x.ms < -noise ? -1 : 0, last = zones.at(-1);
    if (!sign) {zones.push(null); continue;}
    if (last && last.sign === sign && last.to === x.from) {last.to = x.to; last.ms += x.ms;}
    else zones.push({from: x.from, to: x.to, ms: x.ms, sign});
  }
  return zones.filter(z => z && Math.abs(z.ms) >= min).map(({sign, ...z}) => z).sort((a, b) => Math.abs(b.ms) - Math.abs(a.ms));
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
// Metres between two [lat, lon] a few hundred metres apart (flat-earth approximation).
function metres(a, b) {
  const rad = Math.PI / 180;
  return 6371000 * Math.hypot((b[1] - a[1]) * rad * Math.cos((a[0] + b[0]) / 2 * rad), (b[0] - a[0]) * rad);
}
function median(values) {
  const v = values.filter(x => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
// How far each GPS fix sits from the trail: from the fix to the circuit at the fix's own distance.
export function trailOffsets(profile, points, distances) {
  return profile.map(p => metres([p[2], p[3]], circuitPosition(points, distances, p[0])));
}

// The fixes to trust for speed. A watch's GPS can jump, or drift off the trail for several seconds;
// either way it moves the rider along the trail by tens of metres at once (a run at 30 km/h then
// shows 98 km/h). A fix is left out when it sits `offTrailM` further from the trail than the run
// usually does, or when getting to it from the last fix kept needs more than `paceFactor` times the
// rider's pace around it plus 1 m/s (the timing engine's rule for stretches without GPS), allowing
// `errorM` metres of GPS error. The fixes kept keep their exact times, so a stretch left out shows the
// average speed between the fixes around it. Start and finish always stay. `doubtful` are the
// stretches left out, from the fix kept before to the fix kept after.
export function steadyProfile(profile, offsets = null, {offTrailM = 15, paceFactor = 1.6, paceWindowMs = 10000,
                                                      minPace = 3, errorM = 8} = {}) {
  const usual = offsets ? median(offsets) : 0;
  const steps = profile.slice(1).map((p, i) => ({t: p[1],
    v: p[1] > profile[i][1] ? (p[0] - profile[i][0]) * 1000 / (p[1] - profile[i][1]) : null}));
  const pace = t => Math.max(minPace, median(steps.filter(x => Math.abs(x.t - t) <= paceWindowMs).map(x => x.v)) ?? 0);
  const kept = [], doubtful = [];
  let leftOut = null;
  profile.forEach((p, i) => {
    const last = kept.at(-1), seconds = last ? (p[1] - last[1]) / 1000 : 0;
    const offTrail = offsets && offsets[i] > usual + offTrailM;
    const jump = last && p[0] - last[0] > (paceFactor * pace(p[1]) + 1) * seconds + errorM;
    if ((offTrail || jump) && i > 0 && i < profile.length - 1) {
      leftOut ??= last[0];
      return;
    }
    if (leftOut !== null) doubtful.push([leftOut, p[0]]);
    leftOut = null;
    kept.push(p);
  });
  return {profile: kept, doubtful};
}

// Speed along a run every `step` metres, robust to GPS that jumps. At each point the speed is the
// median of the speeds between every pair of fixes within ±`halfMs` (the Theil–Sen slope of
// position over time): one fix out of place changes a few of those pairs, not the median, so it
// cannot show as a peak, while a real change of pace moves them all. `blind` are the stretches
// without reliable GPS (fixes left out, or more than `maxGapMs` between fixes): there the speed is
// only what the fixes around them say.
export function steadySpeed(profile, offsets = null, {step = 10, halfMs = 3000, maxGapMs = 3000} = {}) {
  const steady = steadyProfile(profile, offsets), fixes = steady.profile;
  const samples = resample(fixes, step);
  let first = 0;
  const kmh = samples.map(p => {
    while (first < fixes.length && fixes[first][1] < p.t - halfMs) first++;
    const near = [];
    for (let i = first; i < fixes.length && fixes[i][1] <= p.t + halfMs; i++) near.push(fixes[i]);
    const slopes = [];
    for (let i = 0; i < near.length; i++)
      for (let j = i + 1; j < near.length; j++)
        if (near[j][1] > near[i][1]) slopes.push((near[j][0] - near[i][0]) / (near[j][1] - near[i][1]) * 3600);
    return near.length >= 3 ? median(slopes) : null;
  });
  const blind = [...steady.doubtful];
  fixes.forEach((p, i) => {
    if (i && p[1] - fixes[i - 1][1] > maxGapMs && !blind.some(([a, b]) => a === fixes[i - 1][0] && b === p[0]))
      blind.push([fixes[i - 1][0], p[0]]);
  });
  return {samples, kmh, blind: blind.sort((a, b) => a[0] - b[0])};
}
// Whether a distance falls in a stretch without reliable GPS, give or take `margin` metres.
export function inBlind(blind, s, margin = 0) {
  return blind.some(([a, b]) => s >= Math.min(a, b) - margin && s <= Math.max(a, b) + margin);
}

// Where a run slows down (braking). One GPS fix per second shows where and how much the speed
// drops over tens of metres, not the bite of the brakes: a zone goes from a speed peak to the next
// low point when the speed falls at least `minDropKmh` at `minDecel` m/s² or more on average.
// Next to a stretch without reliable GPS the speed is only an average, so a zone never starts or
// ends there. `speed` is the run's steadySpeed when already worked out.
export function brakingZones(profile, {offsets = null, speed = null, step = 10, minDropKmh = 5, minDecel = 0.2,
                                      resumeKmh = 3} = {}) {
  const {samples, kmh: all, blind} = speed ?? steadySpeed(profile, offsets, {step});
  const kmh = all.map((v, i) => inBlind(blind, samples[i].s, 2 * step) ? null : v);
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

// The braking of one or two runs ([{profile, offsets}]), corner by corner. Two zones that end within
// `joinM` metres are the same corner (closest ends pair first); where only one run brakes, the
// other's zone is null. Each point has, for every run, the time it takes through it (from `marginM`
// before the first zone to `marginM` after the last), its top speed before the slowest point and
// that lowest speed, and whether its GPS is unreliable there; so a run that slows down without a
// clear braking still shows what it does.
export function brakingPoints(runs, {joinM = 35, marginM = 20} = {}) {
  const speeds = runs.map(r => r.speed ?? steadySpeed(r.profile, r.offsets));
  const zones = runs.map((r, k) => brakingZones(r.profile, {speed: speeds[k]}));
  const points = [];
  if (zones.length === 2) {
    const [a, b] = zones, usedA = new Set(), usedB = new Set();
    const close = a.flatMap((x, i) => b.map((y, j) => [Math.abs(x.to - y.to), i, j])).filter(([d]) => d <= joinM);
    for (const [, i, j] of close.sort((p, q) => p[0] - q[0]))
      if (!usedA.has(i) && !usedB.has(j)) {usedA.add(i); usedB.add(j); points.push([a[i], b[j]]);}
    a.forEach((x, i) => usedA.has(i) || points.push([x, null]));
    b.forEach((y, j) => usedB.has(j) || points.push([null, y]));
  } else points.push(...zones.flatMap((list, k) => list.map(z => runs.map((_, n) => n === k ? z : null))));
  const end = Math.min(...runs.map(r => r.profile.at(-1)[0]));
  return points.map(pair => {
    const found = pair.filter(Boolean);
    const from = Math.max(0, Math.min(...found.map(z => z.from)) - marginM);
    const to = Math.min(end, Math.max(...found.map(z => z.to)) + marginM);
    const speed = speeds.map(({samples, kmh, blind}) => {
      const inside = samples.map((p, i) => [p.s, kmh[i]]).filter(([s, v]) => s >= from && s <= to && v !== null);
      const slowest = inside.reduce((best, x) => !best || x[1] < best[1] ? x : best, null);
      const before = inside.filter(([s]) => s <= (slowest?.[0] ?? to)).map(([, v]) => v);
      return {topKmh: before.length ? Math.max(...before) : null, lowKmh: slowest?.[1] ?? null,
        unsure: blind.some(([a, b]) => Math.max(a, b) > from && Math.min(a, b) < to)};
    });
    return {from, to, zones: pair, speed, ms: runs.map(r => timeAt(r.profile, to) - timeAt(r.profile, from))};
  }).sort((p, q) => p.from - q.from);
}
