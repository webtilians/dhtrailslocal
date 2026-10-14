import test from 'node:test';
import assert from 'node:assert/strict';
import {timeAt, resample, speedSeries, gapSeries, segmentTimes, circuitPosition, circuitStretch, brakingZones} from '../telemetry.mjs';

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
