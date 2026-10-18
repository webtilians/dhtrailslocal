import test from 'node:test';
import assert from 'node:assert/strict';
import {readGoproTelemetry, telemetryGpx, videoMoments} from '../gopro.mjs';

// A tiny MP4 like a GoPro's: a telemetry track (gpmd) with one GPMF sample per second, written by hand.
const u32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
const u16 = n => [n >>> 8 & 255, n & 255];
const ascii = s => [...s].map(c => c.charCodeAt(0));
const box = (type, ...parts) => {const body = parts.flat(); return [...u32(8 + body.length), ...ascii(type), ...body];};
const item = (key, type, size, repeat, data) => {
  const body = [...data]; while (body.length % 4) body.push(0);
  return [...ascii(key), type.charCodeAt(0), size, ...u16(repeat), ...body];
};
const i32 = n => u32(n >>> 0);
const container = (key, ...items) => item(key, '\0', 1, items.flat().length, items.flat());

function mp4(samples, {handler = 'meta', format = 'gpmd'} = {}) {
  const ftyp = box('ftyp', ascii('mp42'), u32(0));
  const mdatStart = ftyp.length + 8;
  const sizes = samples.map(s => s.length);
  const stbl = box('stbl',
    box('stsd', u32(0), u32(1), u32(16), ascii(format), [0, 0, 0, 0, 0, 0], u16(1)),
    box('stts', u32(0), u32(1), u32(samples.length), u32(1000)),
    box('stsz', u32(0), u32(0), u32(samples.length), sizes.flatMap(u32)),
    box('stsc', u32(0), u32(1), u32(1), u32(samples.length), u32(1)),
    box('stco', u32(0), u32(1), u32(mdatStart)));
  const trak = box('trak', box('mdia',
    box('mdhd', u32(0), u32(0), u32(0), u32(1000), u32(1000 * samples.length), u32(0)),
    box('hdlr', u32(0), u32(0), ascii(handler), u32(0), u32(0), u32(0), ascii('GoPro MET'), [0]),
    box('minf', stbl)));
  return new Blob([new Uint8Array([...ftyp, ...box('mdat', samples.flat()), ...box('moov', trak)])]);
}
const UTC0 = Date.UTC(2026, 9, 10, 17, 18, 0);  // 10/10/2026 17:18:00 UTC
const DAYS = Math.floor((UTC0 - Date.UTC(2000, 0, 1)) / 86400000), MIDNIGHT = (UTC0 - Date.UTC(2000, 0, 1)) % 86400000;

// HERO11 and later: GPS9, ten points a second with their own time; the clock starts 0.4 s after the video.
function gps9Sample(second, fix = 3) {
  const rows = Array.from({length: 10}, (_, k) => [
    ...i32(Math.round((36.75 - (second * 10 + k) * 1e-5) * 1e7)), ...i32(Math.round(-4.39 * 1e7)), ...i32(300000 - second * 1000),
    ...i32(8000), ...i32(800), ...i32(DAYS), ...i32(MIDNIGHT + second * 1000 + k * 100 + 400), ...u16(150), ...u16(fix)]).flat();
  return container('DEVC', item('DVNM', 'c', 1, 12, ascii('MISSION TEST')), container('STRM',
    item('STNM', 'c', 1, 3, ascii('GPS')),
    item('SCAL', 'l', 4, 9, [1e7, 1e7, 1000, 1000, 100, 1, 1000, 100, 1].flatMap(i32)),
    item('TYPE', 'c', 1, 9, ascii('lllllllSS')),
    item('GPS9', '?', 32, 10, rows)));
}
// Earlier cameras: GPS5 at 18 a second, the UTC time and the fix once per sample.
function gps5Sample(second) {
  const rows = Array.from({length: 18}, (_, k) => [
    ...i32(Math.round((36.75 - (second * 18 + k) * 1e-5) * 1e7)), ...i32(Math.round(-4.39 * 1e7)), ...i32(250000),
    ...i32(7000), ...i32(70)]).flat();
  const t = new Date(UTC0 + second * 1000);
  const stamp = String(t.getUTCFullYear() % 100).padStart(2, '0') + [t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(),
    t.getUTCMinutes(), t.getUTCSeconds()].map(n => String(n).padStart(2, '0')).join('') + '.000';
  return container('DEVC', item('DVNM', 'c', 1, 10, ascii('HERO9 TEST')), container('STRM',
    item('GPSF', 'L', 4, 1, u32(3)), item('GPSU', 'U', 16, 1, ascii(stamp)), item('GPSP', 'S', 2, 1, u16(180)),
    item('SCAL', 'l', 4, 5, [1e7, 1e7, 1000, 1000, 100].flatMap(i32)),
    item('GPS5', 'l', 20, 18, rows)));
}

test('GPS9 telemetry: ten points a second, each with its UTC time, and the gap to the video clock', async () => {
  const t = await readGoproTelemetry(mp4([gps9Sample(0, 0), gps9Sample(1), gps9Sample(2)]));
  assert.equal(t.camera, 'MISSION TEST');
  assert.equal(t.seconds, 3);
  assert.equal(t.points.length, 30);
  assert.equal(t.good, 20);  // the first second has no fix yet
  const p = t.points[10];
  assert.equal(p.t, 1);
  assert.ok(Math.abs(p.lat - (36.75 - 10e-5)) < 1e-9 && Math.abs(p.lon + 4.39) < 1e-9);
  assert.equal(p.ele, 299);
  assert.equal(p.speed, 8);
  assert.equal(p.utc, UTC0 + 1400);
  assert.equal(p.dop, 1.5);
  // Video second = UTC seconds − lag: the video started 0.4 s before 17:18:00.4.
  assert.ok(Math.abs(t.lag - (UTC0 / 1000 + 0.4)) < 1e-6 && t.spread < 1e-6, t.lag);
  const gpx = telemetryGpx(t, 'Bajada');
  assert.equal((gpx.match(/<trkpt /g) || []).length, 20);
  assert.ok(gpx.includes('<time>2026-10-10T17:18:01.400Z</time>') && gpx.includes('creator="DH Trails (GoPro MISSION TEST)"'));
});

test('GPS5 telemetry: the sample time spread over its points', async () => {
  const t = await readGoproTelemetry(mp4([gps5Sample(0), gps5Sample(1)]));
  assert.equal(t.camera, 'HERO9 TEST');
  assert.equal(t.points.length, 36);
  assert.equal(t.good, 36);
  assert.equal(t.points[18].utc, UTC0 + 1000);
  assert.ok(Math.abs(t.points[27].utc - (UTC0 + 1500)) < 1e-6 && Math.abs(t.points[27].t - 1.5) < 1e-9);
  assert.equal(t.points[0].dop, 1.8);
  assert.ok(Math.abs(t.lag - UTC0 / 1000) < 1e-6);
});

test('a video without GoPro telemetry, or not an MP4, is told apart', async () => {
  await assert.rejects(readGoproTelemetry(mp4([gps9Sample(0)], {handler: 'vide', format: 'avc1'})), /telemetría/);
  await assert.rejects(readGoproTelemetry(new Blob([new Uint8Array(64)])), /MP4/);
});

test('moments of a run: a stop despite GPS noise, a hard braking, a shock and a jump', () => {
  // 10 points a second for 20 s: riding at 8 m/s, braking to 2 m/s between 4 and 5.5 s, standing still from
  // 8 to 11 s (the GPS still reads up to 0.4 m/s), then riding again.
  const speed = t => t < 4 ? 8 : t < 5.5 ? 8 - (t - 4) * 4 : t < 7 ? 2 : t < 8 ? 2 - (t - 7) * 2 : t < 11 ? 0.1 + 0.3 * (Math.round(t * 10) % 2) : 6;
  const points = Array.from({length: 200}, (_, i) => ({t: i / 10, speed: speed(i / 10), fix: 3}));
  // 200 readings a second at 1 g, with a 5.2 g landing at 14 s after 0.3 s in the air.
  const t = Array.from({length: 4000}, (_, i) => i / 200);
  const g = t.map(x => x >= 13.7 && x < 14 ? 0.1 : Math.abs(x - 14) < 0.01 ? 5.2 : 1);
  const moments = videoMoments({points, accel: {t, g}}, 0, 20);
  assert.deepEqual(moments.map(m => m.kind), ['brake', 'stop', 'air', 'shock']);
  const [brake, stop, air, shock] = moments;
  assert.ok(Math.abs(brake.t - 3.9) < 0.3 && brake.fromKmh > 25 && brake.toKmh < 12 && brake.peak >= 3.5, JSON.stringify(brake));
  // The average over a second notices the restart half a second early.
  assert.ok(Math.abs(stop.t - 7.9) < 0.3 && stop.seconds > 2.4 && stop.seconds <= 3.1, JSON.stringify(stop));
  assert.ok(Math.abs(air.seconds - 0.3) < 0.02 && Math.abs(shock.g - 5.2) < 1e-9);
  // Outside the run's seconds nothing is counted.
  assert.deepEqual(videoMoments({points, accel: {t, g}}, 15, 20), []);
});
