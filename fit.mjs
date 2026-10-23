// DH Trails v0.8 — FIT files (Garmin, Wahoo, Coros, Suunto and most watches and bike computers) read in the
// browser and turned into a GPX before anything else sees them: the server, the time trial and the circuit
// editor all keep working with GPX. Only the points of the ride are read (the «record» messages: time,
// position, altitude). Pure functions, tested in Node.
import {T} from './i18n.mjs';

const FIT_EPOCH = Date.UTC(1989, 11, 31);      // FIT times are seconds since 31/12/1989 00:00 UTC
const RECORD = 20;                              // global number of the «record» message
const SEMICIRCLE = 180 / 2 ** 31;

// The points of a FIT file: [{lat, lon, ele, time (ms)}], only those with a position and a time.
export function parseFit(buffer) {
  const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  const points = [];
  let offset = 0;
  // A file may hold several FIT files one after another.
  while (offset + 12 <= view.byteLength) {
    const headerSize = view.getUint8(offset), dataSize = view.getUint32(offset + 4, true);
    if (headerSize < 12 || String.fromCharCode(...[8, 9, 10, 11].map(k => view.getUint8(offset + k))) !== '.FIT') {
      if (!points.length) throw new Error(T('El archivo no es un FIT válido.'));
      break;
    }
    readRecords(view, offset + headerSize, Math.min(view.byteLength, offset + headerSize + dataSize), points);
    offset += headerSize + dataSize + 2;      // + the file's CRC
  }
  return points;
}

function readRecords(view, start, end, points) {
  const definitions = new Map();
  let pos = start, lastTime = null;
  while (pos < end) {
    const header = view.getUint8(pos++);
    if (header & 0x80) {
      // A data message with its time compressed into the header: an offset from the last full time.
      const def = definitions.get((header >> 5) & 0x3);
      if (!def) throw new Error(T('El archivo no es un FIT válido.'));
      const offset = header & 0x1f;
      if (lastTime !== null) {
        lastTime = (lastTime & ~0x1f) + offset + (offset < (lastTime & 0x1f) ? 0x20 : 0);
        lastTime >>>= 0;
      }
      const row = readData(view, pos, def);
      pos += def.size;
      if (def.global === RECORD) keep(row, lastTime, points);
      continue;
    }
    const local = header & 0x0f;
    if (header & 0x40) {
      // A definition: which fields the local message type carries from now on, their size and order.
      const little = view.getUint8(pos + 1) === 0;
      const global = view.getUint16(pos + 2, little), count = view.getUint8(pos + 4);
      pos += 5;
      const fields = [];
      for (let i = 0; i < count; i++, pos += 3) fields.push({num: view.getUint8(pos), size: view.getUint8(pos + 1), type: view.getUint8(pos + 2)});
      let extra = 0;
      if (header & 0x20) {     // developer fields: only their size matters here
        const dev = view.getUint8(pos++);
        for (let i = 0; i < dev; i++, pos += 3) extra += view.getUint8(pos + 1);
      }
      definitions.set(local, {little, global, fields, size: fields.reduce((s, f) => s + f.size, 0) + extra});
      continue;
    }
    const def = definitions.get(local);
    if (!def) throw new Error(T('El archivo no es un FIT válido.'));
    const row = readData(view, pos, def);
    pos += def.size;
    if (row.time !== undefined) lastTime = row.time;
    if (def.global === RECORD) keep(row, lastTime, points);
  }
}

// The fields of a «record» this app uses; FIT marks a missing value with the type's largest number.
function readData(view, pos, def) {
  const row = {};
  for (const f of def.fields) {
    const at = pos;
    pos += f.size;
    const read = (bytes, signed) => f.size < bytes ? null : bytes === 4 ? (signed ? view.getInt32(at, def.little) : view.getUint32(at, def.little)) :
      view.getUint16(at, def.little);
    if (f.num === 253) {const v = read(4); if (v !== null && v !== 0xffffffff) row.time = v;}
    else if (def.global !== RECORD) continue;
    else if (f.num === 0) {const v = read(4, true); if (v !== null && v !== 0x7fffffff) row.lat = v * SEMICIRCLE;}
    else if (f.num === 1) {const v = read(4, true); if (v !== null && v !== 0x7fffffff) row.lon = v * SEMICIRCLE;}
    else if (f.num === 78) {const v = read(4); if (v !== null && v !== 0xffffffff) row.ele = v / 5 - 500;}
    else if (f.num === 2 && row.ele === undefined) {const v = read(2); if (v !== null && v !== 0xffff) row.ele = v / 5 - 500;}
  }
  return row;
}

function keep(row, time, points) {
  const t = row.time ?? time;
  if (row.lat === undefined || row.lon === undefined || t === null || t === undefined) return;
  if (Math.abs(row.lat) > 90 || Math.abs(row.lon) > 180) return;
  points.push({lat: row.lat, lon: row.lon, ele: row.ele ?? null, time: FIT_EPOCH + t * 1000});
}

// The points as a GPX file, as they are (a FIT already records whole seconds).
export function pointsGpx(points, name) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="DH Trails (FIT)" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `<trk><name>${esc(name)}</name><trkseg>\n` +
    points.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
      (Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '') + `<time>${new Date(p.time).toISOString().replace('.000Z', 'Z')}</time></trkpt>`).join('\n') +
    '\n</trkseg></trk>\n</gpx>\n';
}

// A file chosen or shared, ready for the rest of the app: a FIT becomes a GPX of the same name; a GPX or
// TCX whose name lost its extension on the way (some apps share a file without it) gets it back; any other
// file stays as it is. Told apart by what is inside, not by the name.
export async function asGpsFile(file) {
  if (!file) return file;
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const base = file.name.replace(/\.(fit|gpx|tcx|xml)$/i, '') || 'ruta';
  if (head.length >= 12 && String.fromCharCode(...head.slice(8, 12)) === '.FIT') {
    const points = parseFit(await file.arrayBuffer());
    if (points.length < 2) throw new Error(T('El archivo FIT no tiene puntos con posición y hora.'));
    return new File([pointsGpx(points, base)], base + '.gpx', {type: 'application/gpx+xml'});
  }
  if (!/\.(gpx|tcx|json)$/i.test(file.name)) {
    const text = new TextDecoder().decode(head);
    if (/<gpx[\s>]/i.test(text)) return new File([file], base + '.gpx', {type: 'application/gpx+xml'});
    if (/<TrainingCenterDatabase/i.test(text)) return new File([file], base + '.tcx', {type: 'application/vnd.garmin.tcx+xml'});
  }
  return file;
}
