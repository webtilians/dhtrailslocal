import test from 'node:test';
import assert from 'node:assert/strict';
import {runGates, gatesPassed} from '../gate-sounds.mjs';

// A 2:00 run with sector gates at 0:40 and 1:25.
const gates = runGates([40000, 85000], 120000);

test('a run has the start, its sector gates and the finish', () => {
  assert.deepEqual(gates.map(g => [g.ms, g.kind]), [[0, 'line'], [40000, 'sector'], [85000, 'sector'], [120000, 'line']]);
});

test('playing through a gate passes it once, from just before to just after', () => {
  assert.deepEqual(gatesPassed(-2000, -1960, gates), []);
  assert.deepEqual(gatesPassed(-40, 0, gates).map(g => g.kind), ['line']);
  assert.deepEqual(gatesPassed(0, 40, gates), [], 'not again on the next frame');
  assert.deepEqual(gatesPassed(39990, 40030, gates).map(g => g.ms), [40000]);
  assert.deepEqual(gatesPassed(119980, 120020, gates).map(g => g.kind), ['line']);
});

test('fast playback still passes every gate between two checks', () => {
  assert.deepEqual(gatesPassed(84000, 86500, gates).map(g => g.ms), [85000]);
  assert.deepEqual(gatesPassed(39000, 41000, runGates([40000, 40500], 90000)).map(g => g.ms), [40000, 40500]);
});

test('jumps, going back, standing still and the first check beep nothing', () => {
  assert.deepEqual(gatesPassed(null, 40010, gates), []);
  assert.deepEqual(gatesPassed(10000, 90000, gates), [], 'a seek forward');
  assert.deepEqual(gatesPassed(90000, 30000, gates), [], 'a loop going back');
  assert.deepEqual(gatesPassed(40000, 40000, gates), [], 'paused on the gate');
  assert.deepEqual(gatesPassed(36000, 44000, gates, 12000).map(g => g.ms), [40000], 'a larger step at ×4');
});
