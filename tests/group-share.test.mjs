import test from 'node:test';
import assert from 'node:assert/strict';
import {ageText, bearing, compass, distanceText, locationSender, shouldSend, whereFrom} from '../group-share.mjs';

const M = 1 / 111195;   // degrees of latitude per metre
const at = (north, east = 0, ele = null) => ({lat: 36.76 + north * M, lon: -4.46 + east * M / Math.cos(36.76 * Math.PI / 180), ele});

test('distances read the way a rider says them', () => {
  assert.equal(distanceText(7.4), '7 m');
  assert.equal(distanceText(343), '340 m');
  assert.equal(distanceText(1234), '1,2 km');
  assert.equal(distanceText(14321), '14 km');
  assert.equal(ageText(20), 'ahora');
  assert.equal(ageText(185), 'hace 3 min');
  assert.equal(ageText(2 * 3600 + 5), 'hace 2 h');
});

test('which way another rider is, and how much higher or lower', () => {
  assert.ok(Math.abs(bearing(at(0), at(500)) - 0) < 0.5);
  assert.ok(Math.abs(bearing(at(0), at(0, 500)) - 90) < 0.5);
  assert.deepEqual(compass(44), {arrow: '↗', name: 'al noreste'});
  assert.deepEqual(compass(350), {arrow: '↑', name: 'al norte'});
  assert.deepEqual(compass(200), {arrow: '↓', name: 'al sur'});
  const below = whereFrom(at(0, 0, 900), at(-300, -300, 840));
  assert.equal(below.distance, '420 m ↙ al suroeste');
  assert.equal(below.climb, '60 m más abajo');
  assert.equal(below.text, '420 m ↙ al suroeste · 60 m más abajo');
  // A few metres of GPS height are not a difference; a few metres away there is no way to tell.
  assert.equal(whereFrom(at(0, 0, 900), at(200, 0, 908)).text, '200 m ↑ al norte');
  assert.equal(whereFrom(at(0), at(8)).text, '8 m');
  assert.equal(whereFrom(null, at(8)), null);
});

test('the phone sends its place every 15 s, sooner when riding, never with a poor fix', () => {
  const last = {...at(0), at: 0};
  assert.equal(shouldSend(null, at(0), 0), true);
  assert.equal(shouldSend(last, at(5), 10000), false);
  assert.equal(shouldSend(last, at(5), 15000), true);
  assert.equal(shouldSend(last, at(40), 4000), false);
  assert.equal(shouldSend(last, at(40), 6000), true);
  assert.equal(shouldSend(last, {...at(40), accuracy: 400}, 30000), false);
  assert.equal(shouldSend(last, {...at(40), accuracy: 400}, 61000), true);
});

test('the sender stops when the server says nothing is shared any more', async () => {
  let now = 0, stopped = 0;
  const sent = [];
  const api = {sendLocation: async fix => {
    if (sent.length === 2) throw Object.assign(new Error('No compartes tu ubicación con ningún grupo'), {status: 409});
    sent.push(fix);
  }};
  const sender = locationSender(api, {clock: () => now, onStopped: () => stopped++});
  assert.equal(await sender.add({...at(0), accuracy: 5, speed: 0}), true);
  now = 3000;
  assert.equal(await sender.add(at(10)), false);
  now = 16000;
  assert.equal(await sender.add({...at(10), speed: 4}), true);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['accuracy', 'ele', 'lat', 'lon', 'speed']);
  assert.equal(sent[0].speed, null);
  assert.equal(sent[1].speed, 4);
  now = 40000;
  assert.equal(await sender.add(at(20)), false);
  assert.equal(stopped, 1);
  assert.equal(sender.stopped, true);
  now = 90000;
  assert.equal(await sender.add(at(20)), false);
  sender.reset();
  assert.equal(sender.stopped, false);
});
