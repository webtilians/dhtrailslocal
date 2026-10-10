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
const START_RADIUS_M = 35;     // fixes this close to the start begin a candidate run
const MATCH_CORRIDOR_M = 60;   // farther than this from the line, a fix does not move the rider
const OFF_COURSE_M = 30;       // separation that counts as leaving the drawn line
const RECOVER_AHEAD_M = 400;   // look-ahead when the local match is poor (e.g. a loop in the reference)
const MAX_SPEED_MS = 25;       // forward search per second of recording (90 km/h)
const BACKTRACK_M = 50;        // the position going back this much along the course needs a review
const BLIND_MS = 10000;        // a gate crossed inside a longer GPS gap has no reliable time
const LOST_MS = 300000;        // five minutes without matching ends a candidate run
const MAX_RUN_MS = 3600000;    // nobody needs an hour for one run
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
function crossingAt(route, a, b, s) {
  const f = b.s === a.s ? 1 : (s - a.s) / (b.s - a.s);
  const ta = route[a.k].time, tb = route[b.k].time;
  const timed = Number.isFinite(ta) && Number.isFinite(tb) && tb >= ta;
  // Interpolating across a long blind stretch would invent the split: the gate stays unknown.
  const blind = timed && tb - ta > BLIND_MS;
  return {k: f < 0.5 ? a.k : b.k, time: timed && !blind ? ta + (tb - ta) * f : null, blind};
}
function elapsedMs(route, from, to) {
  const a = route[from].time, b = route[to].time;
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : (to - from) * 1000;
}
function followRun(route, line, gatesAt, from) {
  const length = line.d.at(-1);
  let prev = null, start = null, finish = null, gates = [], track = [], peak = -Infinity, backtrack = 0, lastSeen = from;
  for (let k = from; k < route.length; k++) {
    if (elapsedMs(route, lastSeen, k) > LOST_MS || elapsedMs(route, from, k) > MAX_RUN_MS) break;
    const p = route[k];
    let m;
    if (!prev) m = alongTrack(line, p, -Infinity, Math.min(length, 60));
    else {
      const seconds = Math.max(1, elapsedMs(route, prev.k, k) / 1000);
      m = alongTrack(line, p, prev.s - 30, prev.s + Math.max(40, MAX_SPEED_MS * seconds));
      if (!m || m.lateral > OFF_COURSE_M) {
        const wide = alongTrack(line, p, prev.s, prev.s + RECOVER_AHEAD_M);
        if (wide && (!m || wide.lateral < m.lateral)) m = wide;
      }
    }
    if (!m || m.lateral > MATCH_CORRIDOR_M) continue;
    const cur = {k, s: m.s, lateral: m.lateral};
    lastSeen = k;
    if (!prev) {
      // The first fix is already past the start line: the start time is taken from it.
      if (cur.s >= 0) start = {k, time: Number.isFinite(p.time) ? p.time : null, blind: false, estimated: cur.s};
    } else if (prev.s < 0 && cur.s >= 0) {
      // Crossing the start line (again) restarts the run: waiting or riding back up is not timed.
      start = {...crossingAt(route, prev, cur, 0), estimated: 0};
      gates = []; track = []; peak = -Infinity; backtrack = 0;
    }
    if (start) {
      track.push(cur);
      if (prev) gatesAt.forEach((g, i) => {
        if (gates[i] === undefined && prev.s < g && cur.s >= g) gates[i] = crossingAt(route, prev, cur, g);
      });
      if (prev && prev.s < length && cur.s >= length) {finish = crossingAt(route, prev, cur, length); break;}
      peak = Math.max(peak, cur.s);
      backtrack = Math.max(backtrack, peak - cur.s);
    }
    prev = cur;
  }
  if (!start || !finish) return null;
  return {start, finish, gates: gatesAt.map((_, i) => gates[i] ?? null), track, backtrack};
}
// Longest stretch of the run ridden more than OFF_COURSE_M away from the line.
function offCourseStretch(track) {
  let worst = null, open = null;
  const close = () => {if (open && (!worst || open.to - open.from > worst.to - worst.from)) worst = open; open = null;};
  for (const f of track) {
    if (f.lateral <= OFF_COURSE_M) {close(); continue;}
    if (!open) open = {from: f.s, to: f.s, meters: f.lateral};
    else {open.to = f.s; open.meters = Math.max(open.meters, f.lateral);}
  }
  close();
  return worst && worst.to - worst.from >= 50 ? worst : null;
}
export function detectAttempts(route, circuit, options = {}) {
  if (!route?.length || !circuit?.points?.length) return [];
  const ref = circuit.points, line = {pts: ref, d: distanceSeries(ref)};
  const radius = options.radius ?? circuit.gateRadius ?? 18;
  const gatesAt = (circuit.sectors || []).map(g => line.d[g.index]);
  const startPoint = {lat: ref[0][0], lon: ref[0][1]};
  const results = [];
  let cursor = 0;
  for (const candidate of gateGroups(route, startPoint, 0, route.length - 1, Math.max(radius, START_RADIUS_M))) {
    if (candidate.first < cursor) continue;
    const run = followRun(route, line, gatesAt, candidate.first);
    if (!run) continue;
    const {start, finish} = run, i0 = start.k, i1 = finish.k;
    if (Number.isFinite(start.time) && Number.isFinite(finish.time) && finish.time - start.time < 12000) continue;
    const times = [start.time, ...run.gates.map(g => g ? g.time : null), finish.time];
    const missing = run.gates.filter(g => !g || g.blind).length;
    const splits = times.slice(1).map((v,i) => v !== null && times[i] !== null && v >= times[i] ? (v - times[i]) / 1000 : null);
    let outside = 0, poorZone = 0, sampled = 0, gaps = 0;
    const stride = Math.max(1,Math.ceil((i1-i0)/180));
    for (let k=i0;k<=i1;k+=stride) {
      const match=proximity(route[k],ref);
      sampled++;
      if(match.meters>30){
        outside++;
        if ((circuit.weakZones || []).some(z => match.index >= z.from && match.index <= z.to)) poorZone++;
      }
    }
    for(let k=i0+1;k<=i1;k++){
      if (Number.isFinite(route[k].time) && Number.isFinite(route[k-1].time) && route[k].time-route[k-1].time>5000) gaps++;
    }
    const confidence=sampled ? 1-outside/sampled : 0;
    const away=offCourseStretch(run.track);
    const timed=Number.isFinite(times[0])&&Number.isFinite(times.at(-1));
    const ok=missing===0 && confidence>=0.86 && !away && run.backtrack<=BACKTRACK_M && poorZone===0 && gaps===0 && timed && start.estimated<=5;
    const issues=[];
    if(missing)issues.push(missing+' puerta(s) de sector sin datos GPS fiables');
    if(confidence<0.86)issues.push('la traza se separa del circuito');
    if(away)issues.push('te separas hasta '+Math.round(away.meters)+' m del trazado entre el km '+(away.from/1000).toFixed(2)+' y el '+(away.to/1000).toFixed(2));
    if(run.backtrack>BACKTRACK_M)issues.push('el GPS retrocede '+Math.round(run.backtrack)+' m por el recorrido');
    if(poorZone)issues.push('desviaciones en zona GPS débil conocida');
    if(gaps)issues.push(gaps+' intervalo(s) sin datos de más de 5 s');
    if(start.estimated>5)issues.push('la salida no aparece en el GPS: tiempo de salida aproximado');
    if(!timed)issues.push('no hay marcas de tiempo completas');
    const seconds=timed&&times.at(-1)>=times[0]?(times.at(-1)-times[0])/1000:null;
    results.push({startIndex:i0,finishIndex:i1,seconds,splits,
      confidence,missing,issues,status:ok?'compatible':'revisar',gateIndices:[i0,...run.gates.map(g=>g?g.k:null),i1]});
    cursor=i1+1;
  }
  return results;
}
// Stops inside the stretch chosen as a circuit reference: a watch that keeps recording while the
// rider stands still writes repeated points and GPS drift, which become a scribble in the line.
// A stop is any 30 s that covers less than 15 m.
export function referenceStops(route, start, finish) {
  const slice = route.slice(start, finish + 1), d = distanceSeries(slice);
  let seconds = 0, until = -Infinity;
  for (let i = 0, j = 0; i < slice.length; i++) {
    if (!Number.isFinite(slice[i].time)) continue;
    j = Math.max(j, i);
    while (j < slice.length && !(Number.isFinite(slice[j].time) && slice[j].time - slice[i].time >= 30000)) j++;
    if (j >= slice.length) break;
    if (d[j] - d[i] < 15) {
      seconds += Math.max(0, slice[j].time - Math.max(slice[i].time, until)) / 1000;
      until = Math.max(until, slice[j].time);
    }
  }
  return seconds;
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
