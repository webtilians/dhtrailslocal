// DH Trails Local v0.2 — pure GPS geometry and timing engine.
// Browser XML parsing is kept separate from the deterministic geometry functions.
export function haversine(a, b) {
  const rad = Math.PI / 180;
  const p = (a.lat ?? a[0]) * rad, q = (b.lat ?? b[0]) * rad;
  const dl = ((b.lon ?? b.lng ?? b[1]) - (a.lon ?? a.lng ?? a[1])) * rad;
  const dp = q - p;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p) * Math.cos(q) * Math.sin(dl / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function parseGps(xml, extension) {
  if (typeof DOMParser === 'undefined') throw new Error('El lector XML necesita un navegador.');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('XML no válido.');
  const root = doc.documentElement.localName.toLowerCase();
  const type = String(extension).toLowerCase();
  if (!((type === 'gpx' && root === 'gpx') || (type === 'tcx' && root === 'trainingcenterdatabase'))) {
    throw new Error('El archivo no corresponde a GPX o TCX.');
  }
  const all = (el, name) => [...el.getElementsByTagNameNS('*', name)];
  const one = (el, name) => el?.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() ?? null;
  const number = x => x === null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x);
  let nodes = all(doc, type === 'gpx' ? 'trkpt' : 'Trackpoint');
  if (!nodes.length && type === 'gpx') nodes = all(doc, 'rtept');
  if (nodes.length > 80000) throw new Error('Archivo demasiado grande: máximo 80.000 puntos.');
  const pts = nodes.map(el => {
    const position = type === 'gpx' ? el : all(el, 'Position')[0];
    const lat = number(type === 'gpx' ? el.getAttribute('lat') : one(position, 'LatitudeDegrees'));
    const lon = number(type === 'gpx' ? el.getAttribute('lon') : one(position, 'LongitudeDegrees'));
    const ele = number(one(el, type === 'gpx' ? 'ele' : 'AltitudeMeters'));
    const value = one(el, type === 'gpx' ? 'time' : 'Time');
    const ms = value ? Date.parse(value) : NaN;
    return {lat, lon, ele, time: Number.isFinite(ms) ? ms : null};
  }).filter(p => p.lat !== null && p.lon !== null && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (pts.length < 2) throw new Error('Necesitamos al menos dos puntos GPS válidos.');
  return pts;
}
export function distanceSeries(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + haversine(points[i - 1], points[i]));
  return cumulative;
}
export function summarize(points) {
  const d = distanceSeries(points);
  const times = points.map(p => p.time).filter(Number.isFinite);
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].ele, b = points[i].ele;
    // Ignore obviously broken altitude jumps; this is NOT filtered elevation.
    if (a !== null && b !== null && a !== undefined && b !== undefined && b < a && a - b < 50) down += a - b;
  }
  return {meters: d.at(-1), points: points.length, seconds: times.length > 1 ? (times.at(-1) - times[0]) / 1000 : null, descent: down};
}
export function nearestTrackIndex(points, location, min = 0, max = points.length - 1) {
  let best = {index: -1, meters: Infinity};
  const a = Math.max(0, Math.ceil(min)), b = Math.min(points.length - 1, Math.floor(max));
  for (let i = a; i <= b; i++) {
    const d = haversine(points[i], location);
    if (d < best.meters) best = {index: i, meters: d};
  }
  return best;
}
export function buildCircuit(name, route, start, finish, sectors, weakZones = []) {
  if (!name || !name.trim()) throw new Error('Escribe un nombre para el circuito.');
  if (!Number.isInteger(start) || !Number.isInteger(finish) || start < 0 || finish >= route.length || finish - start < 15) {
    throw new Error('Marca primero una salida y una meta, separadas por al menos 15 puntos.');
  }
  if (finish - start + 1 > 12000) throw new Error('Circuito demasiado largo para almacenamiento local (12.000 puntos máximo).');
  const gates = [...sectors].sort((a,b) => a.index - b.index);
  if (gates.some((g,i) => g.index <= start || g.index >= finish || (i && g.index <= gates[i - 1].index + 1))) {
    throw new Error('Los sectores deben estar entre salida y meta, en orden y sin superponerse.');
  }
  const zones = weakZones.map(z => ({from: z.from - start, to: z.to - start, name: (z.name || 'Zona de GPS débil').slice(0,70)}));
  if (zones.some(z => z.from < 0 || z.to >= finish - start + 1 || z.to <= z.from)) {
    throw new Error('Las zonas de cobertura débil deben quedar dentro del circuito.');
  }
  const points = route.slice(start, finish + 1).map(p => [Number(p.lat.toFixed(7)), Number(p.lon.toFixed(7)), p.ele ?? null]);
  return {id: 'dh-' + Date.now() + '-' + Math.random().toString(36).slice(2,8), version: 2,
    name: name.trim().slice(0,100), createdAt: new Date().toISOString(), points,
    sectors: gates.map((g,i) => ({index: g.index - start, name: (g.name || 'Sector ' + (i + 1)).slice(0,70)})),
    weakZones: zones, gateRadius: 18};
}
// Projection of a GPS fix on one reference segment, using a small-area metric plane.
function projectedDistance(p, a, b) {
  const lat0 = p.lat * Math.PI / 180;
  const scaleX = 111195 * Math.cos(lat0), scaleY = 111195;
  const ax = (a[1] - p.lon) * scaleX, ay = (a[0] - p.lat) * scaleY;
  const bx = (b[1] - p.lon) * scaleX, by = (b[0] - p.lat) * scaleY;
  const dx = bx - ax, dy = by - ay, denom = dx * dx + dy * dy;
  const u = denom ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
  return Math.hypot(ax + u * dx, ay + u * dy);
}
function proximity(p, ref) {
  let best = {meters: Infinity, index: 0};
  const stride = Math.max(1, Math.ceil(ref.length / 1800));
  for (let i = 0; i < ref.length - 1; i += stride) {
    const j = Math.min(i + stride, ref.length - 1);
    const d = projectedDistance(p, ref[i], ref[j]);
    if (d < best.meters) best = {meters: d, index: i};
  }
  return best;
}
function gateGroups(route, gate, from, until, radius) {
  const groups = [];
  let best = null;
  for (let i = from; i <= until; i++) {
    const d = haversine(route[i], gate);
    if (d <= radius) {
      if (!best) best = {index: i, meters: d, first: i};
      else if (d < best.meters) {best.index = i; best.meters = d;}
    } else if (best) {
      groups.push(best);
      best = null;
    }
  }
  if (best) groups.push(best);
  return groups;
}
// Runs are followed by their position along the reference line (metres from the start). A gate
// is crossed when that position passes it, even if GPS error puts the fix tens of metres to one
// side. The search only looks a little ahead, so the lower leg of a switchback is not confused
// with the upper one; when the local match is poor it looks further ahead to recover.
//
// Trails are singletrack: a fix far from the line is GPS error or lost coverage, not another
// line. Crossings are timed only between reliable fixes, at the average speed of the stretch in
// between. A stretch without reliable GPS is accepted when that average speed is plausible next
// to the rider's own pace around it; only an impossible speed (a shortcut) needs a review.
const START_RADIUS_M = 35;      // fixes this close to the start begin a candidate run
const MATCH_CORRIDOR_M = 60;    // farther than this from the line, a fix does not move the rider
const RELIABLE_M = 30;          // fixes this close to the line time the gates
const RECOVER_AHEAD_M = 400;    // look-ahead when the local match is poor (e.g. a stop drawn into the reference)
const MAX_SPEED_MS = 25;        // forward search per second of recording (90 km/h)
const BLIND_GAP_MS = 5000;      // reliable fixes further apart than this leave a stretch to check
const PACE_WINDOW_MS = 20000;   // the rider's pace just before and just after a stretch
const PACE_FACTOR = 1.6;        // a stretch may be this much faster than that pace (plus 1 m/s)
const MAX_PLAUSIBLE_MS = 22;    // 80 km/h: faster than this on a DH trail is not believable
const ENDPOINT_ERROR_M = 30;    // the two reliable fixes around a stretch can each sit ~15 m off along the trail
const FINISH_WAIT_MS = 30000;   // after a drifting fix past the finish, wait this long for a reliable one
const LOST_MS = 300000;         // five minutes without matching ends a candidate run
const MAX_RUN_MS = 3600000;     // nobody needs an hour for one run
function upperBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {const mid = (lo + hi) >> 1; if (sorted[mid] <= x) lo = mid + 1; else hi = mid;}
  return lo;
}
// Position along the line (negative before the start, beyond the length after the finish)
// and the lateral distance to it, searching segments that overlap [from, to].
function alongTrack(line, p, from, to) {
  const {pts, d} = line, last = pts.length - 2;
  const sx = 111195 * Math.cos(p.lat * Math.PI / 180), sy = 111195;
  let best = null;
  for (let i = Math.max(0, upperBound(d, from) - 1); i <= last && d[i] <= to; i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = (a[1] - p.lon) * sx, ay = (a[0] - p.lat) * sy;
    const dx = (b[1] - a[1]) * sx, dy = (b[0] - a[0]) * sy, denom = dx * dx + dy * dy;
    let u = denom ? -(ax * dx + ay * dy) / denom : 0;
    if (!(i === 0 && u < 0) && !(i === last && u > 1)) u = Math.max(0, Math.min(1, u));
    const lateral = Math.hypot(ax + u * dx, ay + u * dy);
    if (!best || lateral < best.lateral) best = {s: d[i] + u * (d[i + 1] - d[i]), lateral};
  }
  return best;
}
function elapsedMs(route, from, to) {
  const a = route[from].time, b = route[to].time;
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : (to - from) * 1000;
}
// Time at position s between two reliable fixes, at the average speed between them.
function timeAt(route, pair, s) {
  const ta = route[pair.a.k].time, tb = route[pair.b.k].time;
  if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb < ta) return null;
  const f = pair.b.s === pair.a.s ? 1 : Math.max(0, Math.min(1, (s - pair.a.s) / (pair.b.s - pair.a.s)));
  return ta + (tb - ta) * f;
}
function nearestIndex(pair, s) {
  const f = pair.b.s === pair.a.s ? 1 : (s - pair.a.s) / (pair.b.s - pair.a.s);
  return f < 0.5 ? pair.a.k : pair.b.k;
}
function followRun(route, line, gatesAt, from) {
  const length = line.d.at(-1);
  let prev = null, good = null, start = null, finish = null, pending = null, gates = [], track = [], lastSeen = from;
  for (let k = from; k < route.length; k++) {
    if (elapsedMs(route, lastSeen, k) > LOST_MS || elapsedMs(route, from, k) > MAX_RUN_MS) break;
    if (pending && elapsedMs(route, pending.b.k, k) > FINISH_WAIT_MS) break;
    const p = route[k];
    let m;
    if (!prev) m = alongTrack(line, p, -Infinity, Math.min(length, 60));
    else {
      const seconds = Math.max(1, elapsedMs(route, prev.k, k) / 1000);
      m = alongTrack(line, p, prev.s - 30, prev.s + Math.max(40, MAX_SPEED_MS * seconds));
      if (!m || m.lateral > RELIABLE_M) {
        const wide = alongTrack(line, p, prev.s, prev.s + RECOVER_AHEAD_M);
        if (wide && (!m || wide.lateral < m.lateral)) m = wide;
      }
    }
    if (!m || m.lateral > MATCH_CORRIDOR_M) continue;
    const cur = {k, s: m.s, lateral: m.lateral};
    prev = cur;
    lastSeen = k;
    if (cur.lateral > RELIABLE_M) {
      // A drifting fix still moves the search on; crossings wait for a reliable one.
      if (start && good && !pending && good.s < length && cur.s >= length) pending = {a: good, b: cur};
      continue;
    }
    if (!good) {
      // The first reliable fix is already past the start line: the start is estimated from it.
      if (cur.s >= 0) {start = {a: null, b: cur}; track = [cur];}
    } else if (good.s < 0 && cur.s >= 0) {
      // Crossing the start line (again) restarts the run: waiting or riding back up is not timed.
      start = {a: good, b: cur}; gates = []; track = [cur]; pending = null;
    } else if (start) {
      track.push(cur);
      gatesAt.forEach((g, i) => {if (gates[i] === undefined && good.s < g && cur.s >= g) gates[i] = {a: good, b: cur};});
      if (good.s < length && cur.s >= length) {finish = {a: good, b: cur}; break;}
    }
    good = cur;
  }
  if (!finish && pending) {finish = pending; track.push(pending.b);}
  if (!start || !finish) return null;
  gatesAt.forEach((g, i) => {if (gates[i] === undefined && finish.a.s < g && finish.b.s >= g) gates[i] = finish;});
  return {start, finish, gates: gatesAt.map((_, i) => gates[i] ?? null), track};
}
// A start estimated from the first reliable fix goes back at the pace of the next seconds.
function startTime(route, start, track) {
  if (start.a) return timeAt(route, start, 0);
  const b = start.b, tb = route[b.k].time;
  if (!Number.isFinite(tb)) return null;
  const later = track.find(f => Number.isFinite(route[f.k].time) && route[f.k].time - tb >= 5000);
  const pace = later ? (later.s - b.s) / ((route[later.k].time - tb) / 1000) : 0;
  return pace > 0.5 ? tb - b.s / pace * 1000 : tb;
}
function paceBetween(route, a, b) {
  const ta = route[a.k].time, tb = route[b.k].time;
  return Number.isFinite(ta) && Number.isFinite(tb) && tb - ta >= 1000 ? (b.s - a.s) / ((tb - ta) / 1000) : null;
}
// Stretches with no reliable GPS for over 5 s, and whether their average speed is believable.
function blindStretches(route, track, runPace) {
  const out = [];
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1], b = track[i], ta = route[a.k].time, tb = route[b.k].time;
    if (!Number.isFinite(ta) || !Number.isFinite(tb) || tb - ta <= BLIND_GAP_MS) continue;
    let j = i - 1;
    while (j > 0 && ta - route[track[j - 1].k].time <= PACE_WINDOW_MS) j--;
    let n = i;
    while (n < track.length - 1 && route[track[n + 1].k].time - tb <= PACE_WINDOW_MS) n++;
    const around = [paceBetween(route, track[j], a), paceBetween(route, b, track[n]), runPace].filter(v => v !== null && v > 0);
    const pace = Math.max(0, ...around);
    const speed = (b.s - a.s) / ((tb - ta) / 1000);
    const plausible = b.s - a.s < 15 || speed <= Math.min(MAX_PLAUSIBLE_MS, PACE_FACTOR * pace + 1 + ENDPOINT_ERROR_M / ((tb - ta) / 1000));
    out.push({from: a.s, to: b.s, seconds: (tb - ta) / 1000, speed, plausible});
  }
  return out;
}
const km = metres => (metres / 1000).toFixed(2);
export function detectAttempts(route, circuit, options = {}) {
  if (!route?.length || !circuit?.points?.length) return [];
  const ref = circuit.points, line = {pts: ref, d: distanceSeries(ref)}, length = line.d.at(-1);
  const radius = options.radius ?? circuit.gateRadius ?? 18;
  const gatesAt = (circuit.sectors || []).map(g => line.d[g.index]);
  const startPoint = {lat: ref[0][0], lon: ref[0][1]};
  const results = [];
  let cursor = 0;
  for (const candidate of gateGroups(route, startPoint, 0, route.length - 1, Math.max(radius, START_RADIUS_M))) {
    if (candidate.first < cursor) continue;
    const run = followRun(route, line, gatesAt, candidate.first);
    if (!run) continue;
    const {start, finish, track} = run;
    const i0 = start.a ? nearestIndex(start, 0) : start.b.k, i1 = nearestIndex(finish, length);
    const times = [startTime(route, start, track), ...run.gates.map((g, i) => g ? timeAt(route, g, gatesAt[i]) : null), timeAt(route, finish, length)];
    if (Number.isFinite(times[0]) && Number.isFinite(times.at(-1)) && times.at(-1) - times[0] < 12000) continue;
    const missing = run.gates.filter(g => !g).length;
    const splits = times.slice(1).map((v,i) => v !== null && times[i] !== null && v >= times[i] ? (v - times[i]) / 1000 : null);
    let outside = 0, sampled = 0;
    const stride = Math.max(1, Math.ceil((i1 - i0) / 180));
    for (let k = i0; k <= i1; k += stride) {
      sampled++;
      if (proximity(route[k], ref).meters > RELIABLE_M) outside++;
    }
    const confidence = sampled ? 1 - outside / sampled : 0;
    const timed = Number.isFinite(times[0]) && Number.isFinite(times.at(-1));
    const seconds = timed && times.at(-1) >= times[0] ? (times.at(-1) - times[0]) / 1000 : null;
    const stretches = seconds ? blindStretches(route, track, length / seconds) : [];
    const doubtful = stretches.filter(x => !x.plausible), accepted = stretches.filter(x => x.plausible);
    const estimatedStart = start.a ? 0 : start.b.s;
    const ok = timed && missing === 0 && !doubtful.length && confidence >= 0.5 && estimatedStart <= 20;
    const issues = [], notes = [];
    if (missing) issues.push(missing + ' puerta(s) de sector sin datos GPS');
    for (const x of doubtful) issues.push('entre el km ' + km(x.from) + ' y el ' + km(x.to) + ' irías a ' + Math.round(x.speed * 3.6) + ' km/h de media sin GPS fiable: ¿atajo o fallo del GPS?');
    if (confidence < 0.5) issues.push('el GPS se separa del trazado en más de la mitad de la bajada');
    if (estimatedStart > 20) issues.push('la salida no aparece en el GPS');
    if (!timed) issues.push('no hay marcas de tiempo completas');
    if (accepted.length) {
      const x = accepted.reduce((a, b) => b.seconds > a.seconds ? b : a);
      notes.push('GPS perdido o desviado ' + Math.round(x.seconds) + ' s entre el km ' + km(x.from) + ' y el ' + km(x.to) +
        ' a ' + Math.round(x.speed * 3.6) + ' km/h de media, coherente' + (accepted.length > 1 ? ' (y ' + (accepted.length - 1) + ' tramo(s) más)' : '') +
        (gatesAt.some(g => accepted.some(y => g > y.from && g <= y.to)) ? '; parciales estimados con esa velocidad' : ''));
    }
    if (estimatedStart > 5 && estimatedStart <= 20) notes.push('salida estimada: el GPS empieza ' + Math.round(estimatedStart) + ' m después de la línea');
    results.push({startIndex: i0, finishIndex: i1, seconds, splits, confidence, missing, issues, notes,
      status: ok ? 'compatible' : 'revisar',
      gateIndices: [i0, ...run.gates.map((g, i) => g ? nearestIndex(g, gatesAt[i]) : null), i1]});
    cursor = i1 + 1;
  }
  return results;
}
// Stops inside the stretch chosen as a circuit reference: a watch that keeps recording while
// the rider stands still writes repeated points and GPS drift, a scribble in the line. A stop
// starts at a point the rider comes back within 15 m of, at least 30 s later, at under
// 1.5 m/s on average and without going 60 m away; riding through, even a hairpin, never does.
export function stopIntervals(route, start, finish) {
  const stops = [];
  for (let i = start; i < finish;) {
    const p = route[i];
    let end = -1, path = 0;
    if (Number.isFinite(p.time)) {
      for (let j = i + 1; j <= finish; j++) {
        path += haversine(route[j - 1], route[j]);
        const away = haversine(p, route[j]);
        if (away > 60) break;
        const seconds = (route[j].time - p.time) / 1000;
        if (away <= 15 && seconds >= 30 && path / seconds < 1.5) end = j;
      }
    }
    if (end > 0) {stops.push([i, end]); i = end;} else i++;
  }
  return stops;
}
export function referenceStops(route, start, finish) {
  return stopIntervals(route, start, finish).reduce((sum, [a, b]) => sum + (route[b].time - route[a].time) / 1000, 0);
}
// The reference without its stops; gates and weak zones are moved to the kept points.
export function withoutStops(route, start, finish, sectors = [], zones = []) {
  const stops = stopIntervals(route, start, finish);
  const removed = new Set(stops.flatMap(([a, b]) => Array.from({length: Math.max(0, b - a - 1)}, (_, n) => a + 1 + n)));
  const keep = [];
  for (let i = start; i <= finish; i++) if (!removed.has(i)) keep.push(i);
  const at = index => Math.max(0, upperBound(keep, index) - 1);
  return {route: keep.map(i => route[i]), start: 0, finish: keep.length - 1,
    sectors: sectors.map(g => ({...g, index: at(g.index)})),
    zones: zones.map(z => ({...z, from: at(z.from), to: at(z.to)})),
    seconds: stops.reduce((sum, [a, b]) => sum + (route[b].time - route[a].time) / 1000, 0)};
}


// Verify a local-storage write rather than assuming the browser persisted it.
// The caller may export a JSON backup if storage is unavailable or full.
export function readCircuitCollection(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  const value = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('La biblioteca local tiene un formato inesperado.');
  return value;
}
export function writeCircuitCollection(storage, key, circuits) {
  const payload = JSON.stringify(circuits);
  storage.setItem(key, payload);
  if (storage.getItem(key) !== payload) {
    throw new Error('El navegador no confirmó el guardado.');
  }
  return true;
}
