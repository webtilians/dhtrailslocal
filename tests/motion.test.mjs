import test from 'node:test';
import assert from 'node:assert/strict';
import {inflateMotion, readMotion, shocksAndAir, runMoments, roughness} from '../motion.mjs';

// A phone's recording as the app writes it («DHS1»): 40 s at 100 Hz, the phone lying still (1 g) except
// a jump at 11-11.5 s (0.1 g), its landing (6 g), and a rough stretch at 21-26 s (2.5 g and 0.5 g in turn); the
// barometer at 10 Hz. The phone starts 1 s before the run.
const START = Date.UTC(2026, 9, 24, 10, 0, 0);
function phone() {
  const records = [];
  const motion = (t, g) => {
    const r = new DataView(new ArrayBuffer(17));
    r.setUint8(0, 1); r.setUint32(1, t, true);
    r.setInt16(5, 0, true); r.setInt16(7, Math.round(-g * 9.80665 * 100), true); r.setInt16(9, 0, true);
    records.push(r);
  };
  for (let t = 0; t < 40000; t += 10) {
    const g = t >= 11000 && t < 11500 ? 0.1 : t >= 11500 && t < 11520 ? 6 : t >= 21000 && t < 26000 ? 1 + 1.5 * (t % 20 ? 1 : -1) : 1;
    motion(t, g);
    if (t % 100 === 0) {
      const r = new DataView(new ArrayBuffer(9));
      r.setUint8(0, 2); r.setUint32(1, t, true); r.setFloat32(5, 1001.5, true);
      records.push(r);
    }
  }
  const head = new DataView(new ArrayBuffer(16));
  [...'DHS1'].forEach((c, i) => head.setUint8(i, c.charCodeAt(0)));
  head.setUint8(4, 1); head.setFloat64(8, START, true);
  return new Blob([head, ...records]).arrayBuffer();
}
// The run: 10 m/s from the phone's second 1, for 35 s (350 m), one fix a second.
const profile = Array.from({length: 36}, (_, i) => [i * 10, i * 1000, 0, 0]);
const STARTED = START + 1000;

const pack = async (buffer, format) => new Response(new Blob([buffer]).stream().pipeThrough(new CompressionStream(format))).arrayBuffer();

test('the phone\'s file is read whatever the app compressed it with', async () => {
  const raw = await phone();
  for (const buffer of [raw, await pack(raw, 'gzip'), await pack(raw, 'deflate-raw')]) {
    const m = readMotion(await inflateMotion(buffer));
    assert.equal(m.start, START);
    assert.equal(m.t.length, 4000);
    assert.equal(m.pressure.length, 400);
    assert.ok(Math.abs(m.g[0] - 1) < 0.01 && Math.abs(m.g[1150] - 6) < 0.01, String(m.g[1150]));
  }
  assert.throws(() => readMotion(new TextEncoder().encode('DHS2 not ours....').buffer));
  const cut = raw.slice(0, 30);
  assert.throws(() => readMotion(cut));
});

test('shocks and jumps: 4 g or more, and under 0.35 g for 0.2 s', () => {
  const t = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 1.0, 1.5, 2.6], g = [1, 0.2, 0.2, 0.2, 5, 4.5, 1, 7, 4.2, 4.1];
  assert.deepEqual(shocksAndAir({t, g}, 0, 3).map(m => m.kind + (m.g ?? '') + (m.seconds ? '·' + m.seconds.toFixed(1) : '')),
    ['air·0.3', 'shock7', 'shock4.2', 'shock4.1']);
  assert.deepEqual(shocksAndAir({t, g}, 1, 2), [{kind: 'shock', t: 1.0, g: 7}]);
});

test('a run\'s jump and landing, at their second and metre down the circuit', async () => {
  const moments = runMoments(readMotion(await phone()), profile, STARTED);
  const air = moments.find(m => m.kind === 'air'), shock = moments.find(m => m.kind === 'shock');
  assert.ok(Math.abs(air.t - 10) < 0.02 && Math.abs(air.seconds - 0.5) < 0.02, JSON.stringify(air));
  assert.ok(Math.abs(air.s - 100) < 0.5, String(air.s));
  assert.ok(Math.abs(shock.s - 105) < 0.5 && Math.abs(shock.g - 6) < 0.01, JSON.stringify(shock));
  assert.equal(moments.filter(m => m.kind === 'air').length, 1);
});

test('how rough each stretch of the circuit was', async () => {
  const rough = roughness(readMotion(await phone()), profile, STARTED, 25);
  assert.equal(rough.length, 14);
  assert.deepEqual([rough[0].from, rough[0].to, rough.at(-1).to], [0, 25, 350]);
  const shaken = rough.filter(x => x.shake > 0.9).map(x => x.from);
  assert.deepEqual(shaken, [200, 225]);
  assert.ok(rough[4].peak >= 6 - 0.01 && rough[3].shake < 0.6, JSON.stringify(rough.slice(3, 5)));
  // Outside the phone's recording: no readings.
  assert.equal(roughness(readMotion(await phone()), profile, STARTED + 3600000)[0].shake, null);
});
