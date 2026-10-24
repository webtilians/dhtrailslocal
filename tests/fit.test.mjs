import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFit, pointsGpx, asGpsFile} from '../fit.mjs';

// A small FIT file written by hand, like a watch writes it: a file_id message, the definition of «record»
// (time, latitude, longitude, altitude), records with full times and one with its time compressed into
// the header, a record without position (indoors: skipped), and a message with developer fields.
function fitFile() {
  const bytes = [];
  const u8 = v => bytes.push(v & 0xff);
  const u16 = v => {u8(v); u8(v >> 8);};
  const u32 = v => {u16(v & 0xffff); u16(v >>> 16);};
  const semis = deg => Math.round(deg / 180 * 2 ** 31) | 0;
  const t0 = (Date.UTC(2026, 9, 24, 10, 0, 0) - Date.UTC(1989, 11, 31)) / 1000;
  // file_id (global 0): field 4 time_created, uint32
  u8(0x40); u8(0); u8(0); u16(0); u8(1); u8(4); u8(4); u8(0x86);
  u8(0x00); u32(t0);
  // record (global 20) on local type 1: 253 timestamp, 0 lat, 1 lon, 2 altitude
  u8(0x41); u8(0); u8(0); u16(20); u8(4);
  for (const [num, size, type] of [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [2, 2, 0x84]]) {u8(num); u8(size); u8(type);}
  const record = (t, lat, lon, ele) => {u8(0x01); u32(t); u32(semis(lat)); u32(semis(lon)); u16(Math.round((ele + 500) * 5));};
  record(t0, 36.75, -4.39, 280);
  record(t0 + 1, 36.74995, -4.39, 279.6);
  // A compressed-time record on local type 1: offset from the last full time (t0 + 1) → t0 + 2
  u8(0x80 | (1 << 5) | ((t0 + 2) & 0x1f)); u32(0xffffffff); u32(semis(36.7499)); u32(semis(-4.39)); u16(Math.round((279.2 + 500) * 5));
  // No position (invalid values)
  u8(0x01); u32(t0 + 3); u32(0x7fffffff); u32(0x7fffffff); u16(0xffff);
  // A definition with a developer field (header bit 0x20) on local type 2, global 20, then its data
  // (this one also carries 73, enhanced_speed: 5.123 m/s)
  u8(0x62); u8(0); u8(0); u16(20); u8(4);
  for (const [num, size, type] of [[253, 4, 0x86], [0, 4, 0x85], [1, 4, 0x85], [73, 4, 0x86]]) {u8(num); u8(size); u8(type);}
  u8(1); u8(0); u8(2); u8(0);           // one developer field of 2 bytes
  u8(0x02); u32(t0 + 4); u32(semis(36.7498)); u32(semis(-4.39)); u32(5123); u16(1234);
  const data = bytes.splice(0);
  // 14-byte header, the data, a CRC (not checked)
  u8(14); u8(0x20); u16(2132); u32(data.length); for (const c of '.FIT') u8(c.charCodeAt(0)); u16(0);
  bytes.push(...data); u16(0);
  return new Uint8Array(bytes).buffer;
}

test('a FIT file: the points of the ride with their time, position and altitude', () => {
  const points = parseFit(fitFile());
  assert.equal(points.length, 4);
  const start = Date.UTC(2026, 9, 24, 10, 0, 0);
  assert.deepEqual(points.map(p => (p.time - start) / 1000), [0, 1, 2, 4]);
  assert.ok(Math.abs(points[0].lat - 36.75) < 1e-6 && Math.abs(points[0].lon + 4.39) < 1e-6);
  assert.ok(Math.abs(points[1].ele - 279.6) < 0.2);
  assert.equal(points[3].ele, null);
  assert.deepEqual(points.map(p => p.speed), [null, null, null, 5.123]);
  const gpx = pointsGpx(points, 'Bajada <1>');
  assert.equal([...gpx.matchAll(/<gpxtpx:speed>5\.12<\/gpxtpx:speed>/g)].length, 1);
  assert.match(gpx, /creator="DH Trails \(FIT\)"/);
  assert.match(gpx, /<name>Bajada &lt;1&gt;<\/name>/);
  assert.equal([...gpx.matchAll(/<trkpt /g)].length, 4);
  assert.match(gpx, /<time>2026-10-24T10:00:02Z<\/time>/);
});

test('a file that is not a FIT is refused', () => {
  assert.throws(() => parseFit(new TextEncoder().encode('<?xml version="1.0"?><gpx></gpx>').buffer));
});

test('a shared file is told by what it holds: a FIT becomes a GPX, a GPX without extension gets it back', async () => {
  const fit = await asGpsFile(new File([fitFile()], 'Exportar ruta 24-10'));
  assert.equal(fit.name, 'Exportar ruta 24-10.gpx');
  assert.match(await fit.text(), /<trkpt /);
  const gpx = await asGpsFile(new File(['<?xml version="1.0"?><gpx version="1.1"><trk></trk></gpx>'], 'route_2026'));
  assert.equal(gpx.name, 'route_2026.gpx');
  const kept = new File(['<gpx></gpx>'], 'bajada.gpx');
  assert.equal(await asGpsFile(kept), kept);
});
