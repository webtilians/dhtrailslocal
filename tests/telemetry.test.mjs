import test from 'node:test';
import assert from 'node:assert/strict';
import {distanceSeries} from '../gps-engine.mjs';
import {timeAt, resample, speedSeries, gapSeries, segmentTimes, circuitPosition, circuitStretch, brakingZones, brakingPoints,
  trailOffsets, steadyProfile, steadySpeed} from '../telemetry.mjs';

// 100 m at a steady 10 m/s, one fix per second, with a GPS step back at 50 m.
const steady = [[0, 0, 0, 0], [10, 1000, 0, 0], [20, 2000, 0, 0], [30, 3000, 0, 0], [40, 4000, 0, 0],
  [50, 5000, 0, 0], [47, 6000, 0, 0], [60, 6000, 0, 0], [70, 7000, 0, 0], [80, 8000, 0, 0], [90, 9000, 0, 0], [100, 10000, 0, 0]];
// Same course, slow in the second half (5 m/s).
const slower = [[0, 0, 0, 0], [25, 2500, 0, 0], [50, 5000, 0, 0], [75, 10000, 0, 0], [100, 15000, 0, 0]];

test('chart distances interpolate along the circuit bends, not the start/finish chord', () => {
  const points = [[36, -4, 400], [36, -3, 390], [37, -3, 380]];
  assert.deepEqual(circuitPosition(points, [0, 100, 300], 50), [36, -3.5]);
  assert.deepEqual(circuitPosition(points, [0, 100, 300], 200), [36.5, -3]);
  assert.deepEqual(circuitPosition(points, [0, 100, 300], -10), [36, -4]);
  assert.deepEqual(circuitPosition(points, [0, 100, 300], 500), [37, -3]);
});

test('map position handles repeated vertices and empty or invalid data', () => {
  assert.deepEqual(circuitPosition([[36, -4], [36, -4], [37, -3]], [0, 0, 100], 50), [36.5, -3.5]);
  assert.deepEqual(circuitPosition([[36, -4]], [0], 0), [36, -4]);
  assert.equal(circuitPosition([], [], 10), null);
  assert.equal(circuitPosition([[36, -4]], [0], NaN), null);
});

test('time at a position is the first time the rider got there', () => {
  assert.equal(timeAt(steady, 0), 0);
  assert.equal(timeAt(steady, 35), 3500);
  assert.equal(timeAt(steady, 55), 5500);   // the step back to 47 m is ignored
  assert.equal(timeAt(steady, 100), 10000);
});
test('resampling keeps every step and ends at the finish', () => {
  const samples = resample(slower, 30);
  assert.deepEqual(samples.map(p => p.s), [0, 30, 60, 90, 100]);
  assert.deepEqual(samples.map(p => p.t), [0, 3000, 7000, 13000, 15000]);
});
test('speed in km/h follows the pace of each part', () => {
  const speed = speedSeries(resample(slower, 10), 1);
  assert.equal(Math.round(speed[2].kmh), 36);
  assert.equal(Math.round(speed[8].kmh), 18);
});
test('the gap grows where a run is slower than the reference', () => {
  const gap = gapSeries(resample(slower, 10), resample(steady, 10));
  assert.equal(gap[0].ms, 0);
  assert.equal(gap[5].ms, 0);
  assert.equal(gap.at(-1).ms, 5000);
});
test('segment times split the run at the gates', () => {
  assert.deepEqual(segmentTimes(slower, [50]), [5000, 10000]);
  assert.equal(segmentTimes(steady, [30, 60]).reduce((a, b) => a + b), 10000);
});

test('a stretch of the circuit follows its bends between two distances', () => {
  const points = [[36, -4, 400], [36, -3, 390], [37, -3, 380]];
  assert.deepEqual(circuitStretch(points, [0, 100, 300], 50, 200), [[36, -3.5], [36, -3], [36.5, -3]]);
  assert.deepEqual(circuitStretch(points, [0, 100, 300], 20, 80), [[36, -3.8], [36, -3.2]]);
});

// One fix per second along 400 m: `pace(t)` is the speed in m/s during second t.
function ride(pace, seconds = 400) {
  const profile = [[0, 0, 0, 0]];
  for (let t = 1; profile.at(-1)[0] < seconds; t++) profile.push([profile.at(-1)[0] + pace(t), t * 1000, 0, 0]);
  return profile;
}
// 10 m/s, braking to 4 m/s around 200 m (seconds 20 to 23), then speeding up again.
const corner = t => t <= 20 ? 10 : t <= 23 ? 10 - (t - 20) * 2 : t <= 30 ? 4 : t <= 33 ? 4 + (t - 30) * 2 : 10;

test('braking: from the top speed to the low point before the corner', () => {
  const zones = brakingZones(ride(corner));
  assert.equal(zones.length, 1);
  const [zone] = zones;
  assert.ok(zone.from >= 170 && zone.from <= 210, 'starts near 200 m: ' + zone.from);
  assert.ok(zone.to > zone.from && zone.to <= 240, 'ends at the corner: ' + zone.to);
  assert.ok(zone.fromKmh > 30 && zone.toKmh < 20, zone.fromKmh + ' → ' + zone.toKmh);
  assert.ok(zone.decel > 0.5);
});
test('braking: a steady run or a small slowdown is not braking', () => {
  assert.deepEqual(brakingZones(ride(() => 8)), []);
  assert.deepEqual(brakingZones(ride(t => t >= 20 && t < 24 ? 7.5 : 8.5)), []);   // 3.6 km/h, under 5
  // Losing 10 km/h over 300 m is the terrain, not the brakes.
  assert.deepEqual(brakingZones(ride(t => 10 - Math.min(t, 40) * 0.07)), []);
});
test('braking: no zone next to a stretch without reliable GPS', () => {
  // Fixes missing for 8 s right where the run would show braking: its speed is only an average.
  const gap = ride(corner).filter(([, t]) => t <= 15000 || t >= 23000);
  assert.deepEqual(brakingZones(gap), []);
  // A jump of 40 m in a second, then the fixes catch up: no bike does that, so no fake braking after it.
  const jump = ride(() => 8).map(([s, t, ...rest]) => [t >= 20000 && t < 25000 ? s + 40 - (t - 20000) / 125 : s, t, ...rest]);
  assert.deepEqual(brakingZones(jump), []);
  assert.equal(brakingZones(ride(corner)).length, 1);
});
test('braking of two runs pairs the zones of the same corner', () => {
  // The second run brakes a second later (10 m further on) for the same corner.
  const late = ride(t => corner(t - 1));
  const points = brakingPoints([{profile: ride(corner)}, {profile: late}]);
  assert.equal(points.length, 1);
  const [{zones: [a, b], ms, from, to}] = points;
  assert.ok(a && b);
  assert.equal(Math.round(b.from - a.from), 10);
  assert.ok(from < a.from && to > b.to);
  assert.ok(ms[1] < ms[0], 'braking later is faster here: ' + ms);
});
test('braking of two runs: a corner only one run brakes for stays on its own', () => {
  const [point] = brakingPoints([{profile: ride(corner)}, {profile: ride(() => 8)}]);
  assert.ok(point.zones[0] && point.zones[1] === null);
  // What the other run does there: no braking at all, steady at 8 m/s.
  assert.equal(Math.round(point.speed[1].topKmh), 29);
  assert.equal(Math.round(point.speed[1].lowKmh), 29);
  assert.equal(point.speed[1].unsure, false);
  // Corners 100 m apart are different corners.
  const further = brakingPoints([{profile: ride(corner)}, {profile: ride(t => corner(t - 10))}]);
  assert.equal(further.length, 2);
  assert.deepEqual(further.map(p => p.zones.map(z => z !== null)), [[true, false], [false, true]]);
  // One run: every zone is a point.
  assert.deepEqual(brakingPoints([{profile: ride(corner)}]).map(p => p.zones.length), [1]);
});
test('braking of two runs: a slow, gradual slowdown is told, not hidden', () => {
  // Losing 0.18 m/s every second for 30 s: too gradual to count as braking, but through the
  // corner it still loses more than 5 km/h.
  const gradual = t => t <= 10 ? 10 : t <= 40 ? 10 - (t - 10) * 0.18 : 4.6;
  const [point] = brakingPoints([{profile: ride(corner)}, {profile: ride(gradual)}]);
  assert.equal(point.zones[1], null);
  assert.ok(point.speed[1].topKmh - point.speed[1].lowKmh >= 5, JSON.stringify(point.speed[1]));
});

// A circuit due south along one meridian, and GPS fixes along it every second at 8 m/s.
const meridian = Array.from({length: 51}, (_, i) => [36 - i * 10 / 111195, -4]);
const meridianAt = distanceSeries(meridian);
function onTrail(profile, sideways = () => 0) {
  return profile.map(([s, t], i) => {
    const [lat, lon] = circuitPosition(meridian, meridianAt, s);
    return [s, t, lat, lon + sideways(i) / (111195 * Math.cos(lat * Math.PI / 180))];
  });
}
test('how far each fix is from the trail', () => {
  const offsets = trailOffsets(onTrail(ride(() => 8), i => i === 10 ? 25 : 0), meridian, meridianAt);
  assert.ok(offsets[3] < 0.5 && Math.abs(offsets[10] - 25) < 0.5, offsets.slice(8, 12).join());
});
test('steady speed: a GPS jump does not show as a peak', () => {
  // 8 m/s, but the GPS puts the rider 40 m ahead for one second, then 30 and 20 m. The first two are
  // out of reach; 20 m over three seconds is within the GPS error allowed, so that fix stays.
  const jump = ride(() => 8).map(([s, t, ...rest]) => [s + ({20000: 40, 21000: 30, 22000: 20}[t] || 0), t, ...rest]);
  const {profile, doubtful} = steadyProfile(jump);
  assert.equal(profile.length, jump.length - 2);
  assert.deepEqual(doubtful, [[152, 196]]);
  const old = Math.max(...speedSeries(resample(jump, 10), 2).map(p => p.kmh));
  const now = steadySpeed(jump);
  assert.ok(old > 45, 'the plain speed peaks: ' + old);
  assert.ok(Math.max(...now.kmh) < 40, 'steady speed stays near 28.8 km/h: ' + Math.max(...now.kmh));
  assert.deepEqual(now.blind, [[152, 196]]);
});
test('steady speed: one fix out of place changes nothing, a long drift off the trail is left out', () => {
  // 12 m ahead for one second is within GPS error: kept, and the median of the slopes ignores it.
  const nudge = ride(() => 8).map(([s, t, ...rest]) => [t === 20000 ? s + 12 : s, t, ...rest]);
  assert.equal(steadyProfile(nudge).profile.length, nudge.length);
  assert.ok(Math.max(...steadySpeed(nudge).kmh) < 31, Math.max(...steadySpeed(nudge).kmh));
  // Five fixes 30 m off a trail the run otherwise follows within a metre.
  const drift = onTrail(ride(() => 8), i => i >= 20 && i < 25 ? 30 : 0);
  const offsets = trailOffsets(drift, meridian, meridianAt);
  const {profile, doubtful} = steadyProfile(drift, offsets);
  assert.equal(profile.length, drift.length - 5);
  assert.deepEqual(doubtful, [[152, 200]]);
  // A run that is always 20 m off (the circuit drawn a bit to one side) keeps every fix.
  const aside = onTrail(ride(() => 8), () => 20);
  assert.equal(steadyProfile(aside, trailOffsets(aside, meridian, meridianAt)).profile.length, aside.length);
});
