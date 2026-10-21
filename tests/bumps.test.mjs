import test from 'node:test';
import assert from 'node:assert/strict';
import {shakeSeries, matchBumps, samePlace} from '../bumps.mjs';

// A trail: a rock every so often at uneven places, ridden over twice. Run B starts 10 s later in its video
// and is 5 % slower; its camera shakes half as hard (another mount).
const rocks = Array.from({length: 120}, (_, i) => i * 8.3 + 3 * Math.sin(i * 1.7));
const ride = (delay, slower, strength, seed) => {
  const t = [], g = [];
  let r = seed;
  for (let k = 0; k < 200 * 200; k++) {
    const s = k / 200, metres = Math.max(0, (s - delay) * 8 / slower);
    r = (r * 16807) % 2147483647;
    const rock = rocks.some(x => Math.abs(metres - x) < 0.6) ? 1.5 : 0;
    t.push(s); g.push(1 + strength * (rock + 0.15 * (r / 2147483647 - 0.5)));
  }
  return {t, g};
};
const a = shakeSeries(ride(5, 1, 1, 7)), b = shakeSeries(ride(15, 1.05, 0.5, 11));
// The truth: metre m is at 5 + m/8 in A and at 15 + 1.05 m/8 in B.
const truth = tA => 15 + 1.05 * (tA - 5);

test('the bumps find where video B passes the same place, near where the GPS said', () => {
  // The GPS guide is a second and a half off.
  const guide = tA => truth(tA) + 1.5;
  const matches = matchBumps(a, b, guide, {from: 20, to: 140});
  assert.ok(matches.length > 60, String(matches.length));
  for (const [tA, tB] of matches) assert.ok(Math.abs(tB - truth(tA)) < 0.15, `${tA} → ${tB} (${truth(tA)})`);
  const place = samePlace(matches, guide);
  for (const tA of [10, 30.5, 77.7, 150, 190]) assert.ok(Math.abs(place(tA) - truth(tA)) < 0.15, `${tA}: ${place(tA)} vs ${truth(tA)}`);
});

test('a lone wrong match does not move the line, and without matches there is no answer', () => {
  const guide = tA => truth(tA) + 1;
  const matches = matchBumps(a, b, guide, {from: 20, to: 60, every: 2});
  const wrong = [...matches.slice(0, 5), [matches[5][0], matches[5][1] + 2.5, 0.9], ...matches.slice(6)];
  const place = samePlace(wrong, guide);
  assert.ok(Math.abs(place(matches[5][0]) - truth(matches[5][0])) < 0.15);
  assert.equal(samePlace(matches.slice(0, 2), guide), null);
  // Shaking with no bumps in common: nothing clear enough.
  const flat = shakeSeries({t: Array.from({length: 40000}, (_, k) => k / 200), g: Array.from({length: 40000}, (_, k) => 1 + 0.01 * Math.sin(k))});
  assert.equal(matchBumps(a, flat, guide, {from: 20, to: 60}).length, 0);
});
