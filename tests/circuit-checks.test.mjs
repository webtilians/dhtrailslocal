import test from 'node:test';
import assert from 'node:assert/strict';
import {circuitChecks} from '../circuit-checks.mjs';

// A route from directions: each step [metres north, metres east, metres up], a point every few metres.
const LAT = 36.75, LON = -4.39, M_LAT = 1 / 111195, M_LON = 1 / (111195 * Math.cos(LAT * Math.PI / 180));
function walk(steps, from = {lat: LAT, lon: LON, ele: 300}) {
  const out = [from];
  for (const [n, e, up] of steps) {
    const p = out.at(-1);
    out.push({lat: p.lat + n * M_LAT, lon: p.lon + e * M_LON, ele: p.ele + up});
  }
  return out;
}
const repeat = (n, step) => Array.from({length: n}, () => step);
const texts = checks => checks.map(c => c.level + ': ' + c.text);

test('a plain downhill circuit raises nothing', () => {
  const route = walk(repeat(100, [-5, 1, -0.6]));  // 500 m to the south, 60 m down
  assert.deepEqual(circuitChecks(route, 0, route.length - 1, [{index: 50}]), []);
});

test('uphill, short, or with start and finish together', () => {
  const up = walk(repeat(100, [-5, 0, 0.6]));
  assert.match(texts(circuitChecks(up, 0, up.length - 1)).join('\n'), /warning: La meta está 60 m más alta que la salida/);
  const short = walk(repeat(20, [-5, 0, -0.5]));
  assert.match(texts(circuitChecks(short, 0, short.length - 1)).join('\n'), /warning: Mide solo 100 m/);
  // A loop: 200 m south, 30 m east, back north.
  const loop = walk([...repeat(40, [-5, 0, -1]), ...repeat(6, [0, 5, 0]), ...repeat(38, [5, 0, -0.1])]);
  assert.match(texts(circuitChecks(loop, 0, loop.length - 1)).join('\n'), /warning: La salida y la meta están a \d+ m/);
});

test('a hairpin next to a segment end, a short segment, a hole and a GPS spike', () => {
  // Down 250 m, a hairpin 15 m across, back up the slope 250 m further down the hill.
  const route = walk([...repeat(50, [-5, 0, -0.5]), ...repeat(3, [0, 5, -0.5]), ...repeat(50, [5, 0, -0.5])]);
  const hairpin = texts(circuitChecks(route, 0, route.length - 1, [{index: 25}, {index: 28}]));
  assert.ok(hairpin.some(t => /^warning: El fin del segmento 1 está a 15 m de otro paso del trazado \(metro \d+ m\)/.test(t)), hairpin.join('\n'));
  assert.ok(hairpin.some(t => /^warning: El segmento 2 mide solo 15 m/.test(t)), hairpin.join('\n'));
  const holed = walk([...repeat(40, [-5, 0, -0.5]), [-60, 0, -5], ...repeat(40, [-5, 0, -0.5])]);
  assert.match(texts(circuitChecks(holed, 0, holed.length - 1)).join('\n'), /warning: Hay un hueco de 60 m sin puntos en el metro 200 m/);
  const spiked = walk([...repeat(40, [-5, 0, -0.5]), [0, 40, 0], [-5, -40, -0.5], ...repeat(40, [-5, 0, -0.5])]);
  assert.match(texts(circuitChecks(spiked, 0, spiked.length - 1)).join('\n'), /warning: Posible salto del GPS en el metro 200 m/);
});

test('other circuits: the same one again, a shared trail, a start on another circuit', () => {
  const route = walk(repeat(100, [-5, 1, -0.6]));
  const saved = (name, from, to) => ({name, points: route.slice(from, to).map(p => [p.lat, p.lon, p.ele])});
  const same = texts(circuitChecks(route, 0, route.length - 1, [], [saved('Kawasaki', 0, 101)]));
  assert.deepEqual(same, ['warning: Parece el mismo circuito que «Kawasaki»: tiene la misma salida y la misma meta.']);
  assert.deepEqual(texts(circuitChecks(route, 0, route.length - 1, [], [saved('Tramo alto', 0, 70)])),
    ['info: Comparte el 71 % del trazado con «Tramo alto».']);
  // Another circuit that only crosses this one where it starts.
  const crossing = {name: 'Imperial', points: walk(repeat(40, [0, 5, -0.5]), {lat: LAT, lon: LON - 100 * M_LON, ele: 320}).map(p => [p.lat, p.lon, p.ele])};
  assert.match(texts(circuitChecks(route, 0, route.length - 1, [], [crossing])).join('\n'),
    /^info: La salida está sobre el circuito «Imperial»: sus bajadas pasan por aquí\. No se mezclan/);
});
