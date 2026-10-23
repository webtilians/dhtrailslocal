import test from 'node:test';
import assert from 'node:assert/strict';
import {liveTimer, rideGpx, nearestStart, gatePlaces} from '../recorder.mjs';
import {haversine} from '../gps-engine.mjs';

// A circuit straight south, 600 m, a point every 5 m, sector gates at 200 m and 400 m.
const M = 1 / 111195;
const circuit = {points: Array.from({length: 121}, (_, i) => [36.75 - i * 5 * M, -4.39, 280 - i]), sectors: [{index: 40}, {index: 80}]};
// A rider: 20 s standing at the start, then 6 m/s down to 50 m past the finish, a fix every second at a
// random millisecond like a phone.
function ride({wait = 20, speed = 6, from = 0} = {}) {
  const fixes = [];
  let t = Date.UTC(2026, 9, 24, 10, 0, 0) + 137;
  for (let k = 0; k < wait; k++, t += 1000) fixes.push({lat: 36.75 + 3 * M, lon: -4.39, time: t, speed: 0});
  for (let s = from; s <= 650; s += speed, t += 1000) fixes.push({lat: 36.75 - s * M, lon: -4.39, ele: 280 - s / 5, time: t, speed});
  return fixes;
}

test('the gates while riding: the clock starts when riding off, not while standing at the start', () => {
  const timer = liveTimer(circuit), events = [];
  const fixes = ride();
  for (const f of fixes) events.push(...timer.add(f));
  assert.deepEqual(events.map(e => e.kind), ['start', 'sector', 'sector', 'finish']);
  // 600 m at 6 m/s: 100 s, within a fix.
  assert.ok(Math.abs(events.at(-1).elapsed - 100000) <= 1000, String(events.at(-1).elapsed));
  assert.ok(Math.abs(events[1].split - 33333) <= 1000);
  assert.ok(events[0].time >= fixes[20].time, 'not while standing');
  assert.equal(timer.running, false);
});

test('a missed sector gate does not stop the finish, and riding back up starts again', () => {
  const timer = liveTimer(circuit), events = [];
  // No fixes near the first sector gate (GPS lost from 150 m to 250 m).
  for (const f of ride().filter(f => {const s = (36.75 - f.lat) / M; return s < 150 || s > 250;})) events.push(...timer.add(f));
  assert.deepEqual(events.map(e => e.kind), ['start', 'sector', 'finish']);
  assert.equal(events[1].gate, 2);
  // A second run.
  const later = ride().map(f => ({...f, time: f.time + 600000}));
  const again = later.flatMap(f => timer.add(f));
  assert.deepEqual(again.map(e => e.kind), ['start', 'sector', 'sector', 'finish']);
});

test('the ride as a GPX: a point every whole second, nothing made up across a gap', () => {
  const fixes = ride({wait: 3});
  const gaps = [...fixes.slice(0, 30), ...fixes.slice(45).map(f => ({...f, time: f.time + 20000}))];
  const gpx = rideGpx(gaps, 'Bajada <prueba>');
  const times = [...gpx.matchAll(/<time>([^<]+)<\/time>/g)].map(m => Date.parse(m[1]));
  assert.ok(times.every(t => t % 1000 === 0));
  assert.ok(times.every((t, i) => !i || t > times[i - 1]));
  const steps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
  assert.equal(steps.filter(s => s > 1).length, 1);          // only the gap
  assert.match(gpx, /<name>Bajada &lt;prueba&gt;<\/name>/);
  assert.match(gpx, /creator="DH Trails \(GPS del móvil\)"/);
  // Interpolated points stay on the line between the fixes.
  const lats = [...gpx.matchAll(/lat="([^"]+)"/g)].map(m => +m[1]);
  assert.ok(lats.every(l => l <= 36.75 + 3 * M + 1e-7 && l >= 36.75 - 651 * M));
});

test('the circuit whose start is nearest, and its gates', () => {
  const other = {points: [[36.8, -4.4], [36.79, -4.4]], sectors: []};
  const found = nearestStart([other, circuit], {lat: 36.7501, lon: -4.39});
  assert.equal(found.circuit, circuit);
  assert.ok(found.metres < 20);
  assert.equal(gatePlaces(circuit).length, 4);
  assert.ok(haversine(gatePlaces(circuit)[1], {lat: 36.75 - 200 * M, lon: -4.39}) < 0.1);
});
