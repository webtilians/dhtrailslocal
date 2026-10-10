import test from 'node:test';
import assert from 'node:assert/strict';
import {timeAt, resample, speedSeries, gapSeries, segmentTimes} from '../telemetry.mjs';

// 100 m at a steady 10 m/s, one fix per second, with a GPS step back at 50 m.
const steady = [[0, 0, 0, 0], [10, 1000, 0, 0], [20, 2000, 0, 0], [30, 3000, 0, 0], [40, 4000, 0, 0],
  [50, 5000, 0, 0], [47, 6000, 0, 0], [60, 6000, 0, 0], [70, 7000, 0, 0], [80, 8000, 0, 0], [90, 9000, 0, 0], [100, 10000, 0, 0]];
// Same course, slow in the second half (5 m/s).
const slower = [[0, 0, 0, 0], [25, 2500, 0, 0], [50, 5000, 0, 0], [75, 10000, 0, 0], [100, 15000, 0, 0]];

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
