import test from 'node:test';
import assert from 'node:assert/strict';
import {bestGates, gatePhrase, spokenTime} from '../voice.mjs';

test('a time as it is said, to the tenth', () => {
  assert.equal(spokenTime(43950), '44 segundos');
  assert.equal(spokenTime(43940), '43,9 segundos');
  assert.equal(spokenTime(61200), '1 minuto 1,2 segundos');
  assert.equal(spokenTime(163950), '2 minutos 44 segundos');
});

test('your best run to measure against: the fastest whole one with every sector timed', () => {
  const runs = [
    {elapsed_ms: 150000, sector_splits_ms: [50000, 50000, 50000], gps_status: 'compatible'},
    {elapsed_ms: 140000, sector_splits_ms: [40000, null, 50000], gps_status: 'compatible'},       // a sector without time
    {elapsed_ms: 130000, sector_splits_ms: [40000, 40000, 50000], gps_status: 'revisar'},          // under review
    {elapsed_ms: 120000, sector_splits_ms: [40000, 40000, 40000], gps_status: 'compatible', mine: false},  // a friend's
    {elapsed_ms: 145000, sector_splits_ms: [45000, 50000, 50000], gps_status: 'compatible'},
  ];
  assert.deepEqual(bestGates(runs, 2), [45000, 95000, 145000]);
  assert.equal(bestGates(runs, 3), null);   // the circuit has another sector now: no run fits
  assert.equal(bestGates([], 2), null);
});

test('what is said at the start, at each sector gate and at the finish', () => {
  const best = [45000, 95000, 145000];
  assert.equal(gatePhrase({kind: 'start', gate: 0, elapsed: 0}, 'kawasaki', best), 'Empieza kawasaki.');
  assert.equal(gatePhrase({kind: 'sector', gate: 1, elapsed: 46400}, 'kawasaki', best), 'Sector 1. Vas 1,4 segundos peor que tu mejor tiempo.');
  assert.equal(gatePhrase({kind: 'sector', gate: 2, elapsed: 94000}, 'kawasaki', best), 'Sector 2. Vas 1 segundo mejor que tu mejor tiempo.');
  assert.equal(gatePhrase({kind: 'sector', gate: 2, elapsed: 95040}, 'kawasaki', best), 'Sector 2. Vas igual que tu mejor tiempo.');
  assert.equal(gatePhrase({kind: 'finish', gate: 3, elapsed: 147000}, 'kawasaki', best, 146600),
    'Fin de kawasaki. Tu tiempo ha sido 2 minutos 26,6 segundos. 1,6 segundos peor que tu mejor tiempo.');
  assert.equal(gatePhrase({kind: 'finish', gate: 3, elapsed: 143000}, 'kawasaki', best, 143200),
    'Fin de kawasaki. Tu tiempo ha sido 2 minutos 23,2 segundos. ¡Nuevo récord! 1,8 segundos mejor que tu mejor tiempo.');
  // Without a best run (the first time on a circuit): the time at each gate.
  assert.equal(gatePhrase({kind: 'sector', gate: 1, elapsed: 65300}, 'Aldi', null), 'Sector 1. 1 minuto 5,3 segundos.');
  assert.equal(gatePhrase({kind: 'finish', gate: 1, elapsed: 407000}, 'Aldi', null), 'Fin de Aldi. Tu tiempo ha sido 6 minutos 47 segundos.');
});
