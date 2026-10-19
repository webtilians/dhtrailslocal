import test from 'node:test';
import assert from 'node:assert/strict';
import {idealRun, sectorDeltas, progressSeries, runReport, worstStretch} from '../insights.mjs';

// Three days on a three-sector circuit, a sector a day better than the others.
const run = (id, day, splits) => ({id, started_at: `2026-10-${String(day).padStart(2, '0')}T10:00:00Z`,
  elapsed_ms: splits.reduce((a, b) => a + (b || 0), 0), sector_splits_ms: splits});
const a = run('a', 1, [30000, 60000, 90000]);   // 3:00
const b = run('b', 10, [28000, 63000, 91000]);  // 3:02, best S1
const c = run('c', 18, [31000, 58000, 88500]);  // 2:57.5, best S2 and S3

test('the ideal run puts the best of each sector together, and says which run each came from', () => {
  const ideal = idealRun([a, b, c]);
  assert.equal(ideal.ms, 28000 + 58000 + 88500);
  assert.deepEqual(ideal.sectors.map(s => s.run.id), ['b', 'c', 'c']);
  assert.equal(ideal.fastest.id, 'c');
  assert.equal(ideal.margin, 177500 - 174500);
  // A sector without a time in any run: no ideal yet.
  assert.equal(idealRun([run('x', 1, [30000, null, 90000])]), null);
  assert.equal(idealRun([]), null);
});

test('sector deltas only where both runs have a time', () => {
  assert.deepEqual(sectorDeltas(c, a), [{sector: 0, ms: 1000}, {sector: 1, ms: -2000}, {sector: 2, ms: -1500}]);
  assert.deepEqual(sectorDeltas(run('y', 2, [null, 61000, 90000]), a), [{sector: 1, ms: 1000}, {sector: 2, ms: 0}]);
});

test('progress: days since the first run, the record so far, and each sector over the best one', () => {
  const p = progressSeries([c, a, b]);
  assert.deepEqual(p.points.map(x => x.run.id), ['a', 'b', 'c']);
  assert.deepEqual(p.points.map(x => x.x), [0, 9, 17]);
  assert.deepEqual(p.points.map(x => x.record), [180000, 180000, 177500]);
  assert.deepEqual(p.points[0].over, [2000, 2000, 1500]);
  assert.deepEqual(p.points[2].over, [3000, 0, 0]);
  assert.equal(p.sectors, 3);
});

test('a new run told against the earlier ones', () => {
  const report = runReport(c, [a, b, c]);
  assert.equal(report.record, true);
  assert.equal(report.best.id, 'a');
  assert.equal(report.previous.id, 'b');
  assert.equal(report.vsBest, -2500);
  assert.equal(report.vsPrevious, -4500);
  assert.deepEqual(report.gained, {sector: 1, ms: -5000});   // S2 against the previous run
  assert.deepEqual(report.lost, {sector: 0, ms: 3000});
  assert.deepEqual(report.margin, {sector: 0, ms: 3000});    // 3 s over the best S1 ever
  // The first run on a circuit: a record, nothing to compare.
  const first = runReport(a, [a]);
  assert.equal(first.record, true);
  assert.equal(first.best, null);
  assert.equal(first.vsPrevious, null);
  assert.equal(first.margin, null);
});

test('the 100 m where a run loses most, not a long zone', () => {
  // Every 25 m: a little lost all along, and 2.4 s between 250 and 350 m.
  const stretches = Array.from({length: 24}, (_, i) => ({from: i * 25, to: i * 25 + 25, ms: i >= 10 && i < 14 ? 600 : 100}));
  assert.deepEqual(worstStretch(stretches), {from: 250, to: 350, ms: 2400});
  assert.equal(worstStretch(stretches.map(s => ({...s, ms: -s.ms}))), null);
  assert.equal(worstStretch([]), null);
  // A circuit shorter than the window: all of it.
  assert.deepEqual(worstStretch(stretches.slice(0, 2)), {from: 0, to: 50, ms: 200});
});
