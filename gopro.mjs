// DH Trails — the telemetry a GoPro writes inside its MP4 (GPMF), read in the browser from the file
// itself: only the MP4 index and the telemetry samples, never the picture, and nothing leaves the device.
// GPS9 (HERO11 and later: 10 points a second, each with its UTC time) and GPS5 (earlier cameras:
// 18 a second, the UTC time once per sample) are both read. The camera's clock follows the GPS, so
// the UTC time of any moment of a run gives the second of the video where it happens.
import {T} from './i18n.mjs';

async function bytes(file, start, end) {
  return new DataView(await file.slice(start, end).arrayBuffer());
}
const fourcc = (view, at) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

// The boxes at the top of the file, read header by header (the media data can take gigabytes).
async function topBoxes(file) {
  const out = [];
  for (let pos = 0; pos + 8 <= file.size;) {
    const head = await bytes(file, pos, Math.min(file.size, pos + 16));
    let size = head.getUint32(0), start = pos + 8;
    if (size === 1) {size = Number(head.getBigUint64(8)); start = pos + 16;}
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    out.push({type: fourcc(head, 4), start, end: pos + size});
    pos += size;
  }
  return out;
}
// Boxes inside a box already in memory.
function boxes(view, start, end) {
  const out = [];
  for (let pos = start; pos + 8 <= end;) {
    let size = view.getUint32(pos), head = 8;
    if (size === 1) {size = Number(view.getBigUint64(pos + 8)); head = 16;}
    else if (size === 0) size = end - pos;
    if (size < 8) break;
    out.push({type: fourcc(view, pos + 4), start: pos + head, end: pos + size});
    pos += size;
  }
  return out;
}
function child(view, box, ...path) {
  for (const type of path) {
    box = boxes(view, box.start, box.end).find(b => b.type === type);
    if (!box) return null;
  }
  return box;
}

function track(view, trak) {
  const hdlr = child(view, trak, 'mdia', 'hdlr'), mdhd = child(view, trak, 'mdia', 'mdhd');
  const stbl = child(view, trak, 'mdia', 'minf', 'stbl');
  if (!hdlr || !mdhd || !stbl) return null;
  const v1 = view.getUint8(mdhd.start) === 1;
  const timescale = view.getUint32(mdhd.start + (v1 ? 20 : 12));
  const duration = v1 ? Number(view.getBigUint64(mdhd.start + 24)) : view.getUint32(mdhd.start + 16);
  const stsd = child(view, stbl, 'stsd');
  const info = {handler: fourcc(view, hdlr.start + 8), format: stsd ? fourcc(view, stsd.start + 12) : '', timescale,
    seconds: duration / timescale, stbl};
  return info;
}
// File offset, size and video time of every sample of a track.
function samples(view, info) {
  const {stbl, timescale} = info;
  const stsz = child(view, stbl, 'stsz'), stsc = child(view, stbl, 'stsc'), stts = child(view, stbl, 'stts');
  const co = child(view, stbl, 'stco') || child(view, stbl, 'co64'), wide = !child(view, stbl, 'stco');
  const fixed = view.getUint32(stsz.start + 4), count = view.getUint32(stsz.start + 8);
  const size = i => fixed || view.getUint32(stsz.start + 12 + 4 * i);
  const chunks = Array.from({length: view.getUint32(co.start + 4)}, (_, i) =>
    wide ? Number(view.getBigUint64(co.start + 8 + 8 * i)) : view.getUint32(co.start + 8 + 4 * i));
  const runs = Array.from({length: view.getUint32(stsc.start + 4)}, (_, i) =>
    [view.getUint32(stsc.start + 8 + 12 * i), view.getUint32(stsc.start + 12 + 12 * i)]);
  const durations = [];
  for (let i = 0, n = view.getUint32(stts.start + 4); i < n; i++)
    for (let k = 0, c = view.getUint32(stts.start + 8 + 8 * i); k < c; k++) durations.push(view.getUint32(stts.start + 12 + 8 * i));
  const out = [];
  let s = 0, t = 0;
  runs.push([chunks.length + 1, 0]);
  for (let r = 0; r + 1 < runs.length; r++)
    for (let chunk = runs[r][0]; chunk < runs[r + 1][0]; chunk++) {
      let pos = chunks[chunk - 1];
      for (let k = 0; k < runs[r][1] && s < count; k++, s++) {
        const d = (durations[s] ?? durations.at(-1) ?? 0) / timescale;
        out.push({pos, size: size(s), time: t, duration: d});
        pos += size(s); t += d;
      }
    }
  return out;
}

// GPMF: key, type, size of one item, how many; payloads padded to 4 bytes. Type 0 holds more items.
function* klv(view, start, end) {
  for (let pos = start; pos + 8 <= end;) {
    const type = view.getUint8(pos + 4), size = view.getUint8(pos + 5), repeat = view.getUint16(pos + 6);
    yield {key: fourcc(view, pos), type: String.fromCharCode(type), size, repeat, start: pos + 8, end: pos + 8 + size * repeat};
    pos += 8 + ((size * repeat + 3) & ~3);
  }
}
const READ = {b: ['getInt8', 1], B: ['getUint8', 1], s: ['getInt16', 2], S: ['getUint16', 2], l: ['getInt32', 4],
  L: ['getUint32', 4], f: ['getFloat32', 4], d: ['getFloat64', 8]};
function numbers(view, item, typedef = null) {
  const kinds = item.type === '?' ? typedef : null;
  const rows = [];
  for (let r = 0; r < item.repeat; r++) {
    const row = [];
    let at = item.start + r * item.size;
    if (kinds) {
      for (const k of kinds) {
        if (!READ[k]) return null;
        row.push(view[READ[k][0]](at)); at += READ[k][1];
      }
    } else {
      const [method, width] = READ[item.type] || [];
      if (!method) return null;
      for (let i = 0; i < item.size / width; i++) {row.push(view[method](at)); at += width;}
    }
    rows.push(row);
  }
  return rows;
}
const text = (view, item) => {
  let out = '';
  for (let i = item.start; i < item.end; i++) out += String.fromCharCode(view.getUint8(i));
  return out.replace(/\0+$/, '');
};
// "yymmddhhmmss.sss" in UTC.
const gpsu = s => Date.UTC(2000 + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10), 0) + parseFloat(s.slice(10)) * 1000;
const median = values => {const v = [...values].sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null;};

// {camera, seconds, points: [{t (video second), utc (ms), lat, lon, ele, speed (m/s), fix, dop}], lag, spread,
//  accel: {t: [video seconds], g: [total acceleration in g]}}
// lag: video second = UTC seconds − lag; spread: how much that gap varies along the video, in seconds.
// speed is the GPS's own (Doppler) measure, ten times a second: much finer than positions a second apart.
export async function readGoproTelemetry(file) {
  const moovBox = (await topBoxes(file)).find(b => b.type === 'moov');
  if (!moovBox) throw new Error(T('No es un vídeo MP4.'));
  const view = await bytes(file, moovBox.start, moovBox.end);
  const tracks = boxes(view, 0, view.byteLength).filter(b => b.type === 'trak').map(b => track(view, b)).filter(Boolean);
  const meta = tracks.find(t => t.format === 'gpmd'), video = tracks.find(t => t.handler === 'vide');
  if (!meta) throw new Error(T('Este vídeo no lleva la telemetría de GoPro (GPS).'));
  const points = [], accel = {t: [], g: []};
  let camera = '';
  for (const sample of samples(view, meta)) {
    const data = await bytes(file, sample.pos, sample.pos + sample.size);
    for (const devc of klv(data, 0, data.byteLength)) {
      if (devc.key !== 'DEVC') continue;
      for (const item of klv(data, devc.start, devc.end)) {
        if (item.key === 'DVNM' && !camera) camera = text(data, item);
        if (item.key !== 'STRM') continue;
        let scale = [1], typedef = null, utc = null, fix = null, dop = null, gps = null, nine = false, accl = null;
        for (const f of klv(data, item.start, item.end)) {
          if (f.key === 'SCAL') scale = numbers(data, f).map(r => r[0]);
          else if (f.key === 'TYPE') typedef = text(data, f);
          else if (f.key === 'GPSU') utc = gpsu(text(data, f));
          else if (f.key === 'GPSF') fix = numbers(data, f)[0][0];
          else if (f.key === 'GPSP') dop = numbers(data, f)[0][0] / 100;
          else if (f.key === 'GPS9' || f.key === 'GPS5') {gps = numbers(data, f, typedef); nine = f.key === 'GPS9';}
          else if (f.key === 'ACCL') accl = numbers(data, f);
        }
        // About 200 readings a second (m/s², in the camera's axes): kept as the total, in g.
        accl?.forEach((r, k) => {
          const unit = scale[0] || 1;
          accel.t.push(sample.time + k / accl.length * sample.duration);
          accel.g.push(Math.hypot(r[0] / unit, r[1] / unit, r[2] / unit) / 9.80665);
        });
        if (!gps) continue;
        gps.forEach((raw, k) => {
          const v = raw.map((x, i) => x / (scale[i] ?? scale[0] ?? 1));
          const t = sample.time + k / gps.length * sample.duration;
          const time = nine ? Date.UTC(2000, 0, 1) + (v[5] * 86400 + v[6]) * 1000 :
            utc === null ? null : utc + k / gps.length * sample.duration * 1000;
          points.push({t, utc: time, lat: v[0], lon: v[1], ele: v[2], speed: v[3], fix: nine ? v[8] : fix, dop: nine ? v[7] : dop});
        });
      }
    }
  }
  const good = points.filter(p => p.fix >= 2 && p.utc !== null);
  const gaps = good.map(p => p.utc / 1000 - p.t);
  return {camera, seconds: video?.seconds ?? meta.seconds, points, good: good.length, accel,
    lag: median(gaps), spread: gaps.length ? Math.max(...gaps) - Math.min(...gaps) : null};
}

// The GPS points with a fix as a GPX, to upload like a watch's route.
export function telemetryGpx(telemetry, name) {
  const esc = s => String(s).replace(/[<>&"]/g, c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;'})[c]);
  const pts = telemetry.points.filter(p => p.fix >= 2 && p.utc !== null);
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="DH Trails (GoPro ' + esc(telemetry.camera) + ')" ' +
    'xmlns="http://www.topografix.com/GPX/1/1"><trk><name>' + esc(name) + '</name><trkseg>' +
    pts.map(p => '<trkpt lat="' + p.lat.toFixed(7) + '" lon="' + p.lon.toFixed(7) + '"><ele>' + p.ele.toFixed(1) +
      '</ele><time>' + new Date(p.utc).toISOString() + '</time></trkpt>').join('') + '</trkseg></trk></gpx>\n';
}

// Whether the camera's own GPS can be trusted between two seconds of the video: GoPro calls a fix good
// when its DOP is under 5, and when the run comes from another GPS (a watch) both must agree, within
// 20 m at the same moments. With the camera badly placed or under trees, its positions fall tens of
// metres behind and its speed reads several km/h low: on 18/10/2026, 60 m and 5-10 km/h on two runs.
// place(utc ms) is where the run was at that moment, or null.
// {ok, dop (median), offM (median metres from the run, or null)}
export function cameraGps(telemetry, from, to, place = null) {
  const pts = telemetry.points.filter(p => p.fix >= 2 && p.utc !== null && p.t >= from && p.t <= to);
  const k = Math.PI / 180;
  const metres = (a, b) => 6371000 * Math.hypot((b.lon - a.lon) * k * Math.cos(a.lat * k), (b.lat - a.lat) * k);
  const dop = median(pts.map(p => p.dop).filter(Number.isFinite));
  const offM = place ? median(pts.filter((_, i) => i % 5 === 0).map(p => {const q = place(p.utc); return q ? metres(p, q) : null;})
    .filter(x => x !== null)) : null;
  return {ok: pts.length >= 10 && (dop === null || dop < 5) && (offM === null || offM <= 20), dop, offM};
}

// Stops from the camera's shaking alone, for when its GPS cannot be trusted: riding a trail always
// shakes it (a spread of 0.18 g or more over a second in real runs), standing still does not (under
// 0.15 g). Two seconds at least; on a real run it found the same two stops as the GPS's speed.
function stillStops(accel, from, to) {
  const {t, g} = accel, out = [], sum = [0], squares = [0];
  for (let i = 0; i < t.length; i++) {sum.push(sum[i] + g[i]); squares.push(squares[i] + g[i] * g[i]);}
  let a = 0, b = 0, still = null;
  for (let c = from; c <= to + 0.25; c += 0.25) {
    while (a < t.length && t[a] < c - 0.5) a++;
    while (b < t.length && t[b] < c + 0.5) b++;
    const n = b - a, mean = n ? (sum[b] - sum[a]) / n : 0;
    const spread = n >= 20 ? Math.sqrt(Math.max(0, (squares[b] - squares[a]) / n - mean * mean)) : null;
    if (c <= to && spread !== null && spread < 0.15) still ??= c;
    else {
      if (still !== null && c - still >= 2) out.push({kind: 'stop', t: still, until: Math.min(c, to), seconds: Math.min(c, to) - still});
      still = null;
    }
  }
  return out;
}

// What happened between two seconds of the video that is worth a look when training, each with the
// second it starts at:
// - stop: under 2 km/h on average over each second, for 1.5 s or more (a foot down, a stall, a wait);
//   standing still, a GoPro's GPS still reads 0.2-1.5 km/h. Without a trustworthy GPS ({gps: false}),
//   from the camera's shaking instead, and no braking: that is left to the run's own GPS;
// - brake: losing speed at 2.5 m/s² or more (a quarter of g) over half a second, from the GPS's own
//   speed, and at least 5 km/h in all; pauses under 0.7 s do not split a braking;
// - shock: 4 g or more (a landing, a root, a rock), at most one a second;
// - air: under 0.35 g for 0.2 s or more (the camera falling with the rider: a jump or a drop).
// The thresholds come from real GoPro runs: on trails ridden at 20-30 km/h, braking into corners
// reaches 2.5-5.5 m/s², shocks 4-11 g, and a smooth run never stays under 0.35 g for 0.2 s.
export function videoMoments(telemetry, from, to, {gps = true} = {}) {
  const out = gps ? [] : stillStops(telemetry.accel || {t: [], g: []}, from, to);
  const pts = gps ? telemetry.points.filter(p => p.fix >= 2 && p.t >= from && p.t <= to) : [];
  const around = (i, seconds) => {
    const near = pts.filter(q => Math.abs(q.t - pts[i].t) <= seconds / 2);
    return near.reduce((sum, q) => sum + q.speed, 0) / near.length;
  };
  let still = null;
  pts.forEach((p, i) => {
    if (around(i, 1) < 0.55) still ??= p.t;
    else {
      if (still !== null && p.t - still >= 1.5) out.push({kind: 'stop', t: still, until: p.t, seconds: p.t - still});
      still = null;
    }
  });
  if (gps && still !== null && to - still >= 1.5) out.push({kind: 'stop', t: still, until: to, seconds: to - still});
  const v = pts.map((_, i) => around(i, 0.3));
  const brakes = [];
  for (let i = 5; i < pts.length; i++) {
    if (pts[i].t <= pts[i - 5].t || (v[i - 5] - v[i]) / (pts[i].t - pts[i - 5].t) < 2.5) continue;
    const rate = (v[i - 5] - v[i]) / (pts[i].t - pts[i - 5].t), last = brakes.at(-1);
    if (last && pts[i - 5].t - last.until < 0.7) {
      last.until = pts[i].t; last.toKmh = Math.min(last.toKmh, v[i] * 3.6); last.peak = Math.max(last.peak, rate);
    } else brakes.push({kind: 'brake', t: pts[i - 5].t, until: pts[i].t, fromKmh: v[i - 5] * 3.6, toKmh: v[i] * 3.6, peak: rate});
  }
  out.push(...brakes.filter(b => b.fromKmh - b.toKmh >= 5));
  const {t, g} = telemetry.accel || {t: [], g: []};
  let shock = null, air = null;
  for (let i = 0; i < t.length; i++) {
    if (t[i] < from || t[i] > to) continue;
    if (g[i] >= 4) {
      if (shock && t[i] - shock.t < 1) shock.g = Math.max(shock.g, g[i]);
      else out.push(shock = {kind: 'shock', t: t[i], g: g[i]});
    }
    if (g[i] < 0.35) air ??= t[i];
    else {
      if (air !== null && t[i] - air >= 0.2) out.push({kind: 'air', t: air, seconds: t[i] - air});
      air = null;
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
