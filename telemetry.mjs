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
