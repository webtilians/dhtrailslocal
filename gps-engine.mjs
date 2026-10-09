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
      if (!best || d < best.meters) best = {index: i, meters: d};
    } else if (best) {
      groups.push(best);
      best = null;
    }
  }
  if (best) groups.push(best);
  return groups;
}
// Approximate closest approach to gate, interpolated between consecutive timestamped fixes.
function timeAtGate(route, index, gate) {
  let best = {distance: Infinity, time: route[index]?.time ?? null};
  for (const j of [index - 1, index]) {
    if (j < 0 || j + 1 >= route.length) continue;
    const a = route[j], b = route[j + 1];
    if (!Number.isFinite(a.time) || !Number.isFinite(b.time) || b.time < a.time) continue;
    const lat0 = gate.lat * Math.PI / 180, sx = 111195 * Math.cos(lat0), sy = 111195;
    const ax = (a.lon - gate.lon) * sx, ay = (a.lat - gate.lat) * sy;
    const dx = (b.lon - a.lon) * sx, dy = (b.lat - a.lat) * sy;
    const denom = dx * dx + dy * dy;
    const u = denom ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denom)) : 0;
    const distance = Math.hypot(ax + u * dx, ay + u * dy);
    if (distance < best.distance) best = {distance, time: a.time + (b.time - a.time) * u};
  }
  return best.time;
}
export function detectAttempts(route, circuit, options = {}) {
  if (!route?.length || !circuit?.points?.length) return [];
  const ref = circuit.points, dRef = distanceSeries(ref), dUser = distanceSeries(route);
  const gates = [{index: 0, name: 'Salida'}, ...(circuit.sectors || []), {index: ref.length - 1, name: 'Meta'}];
  const radius = options.radius ?? circuit.gateRadius ?? 18;
  const starts = gateGroups(route, {lat:ref[0][0],lon:ref[0][1]}, 0, route.length - 1, radius);
  const results = [];
  let cursor = 0;
  for (const s of starts) {
    if (s.index < cursor) continue;
    const finishPoint = {lat:ref.at(-1)[0],lon:ref.at(-1)[1]};
    const minDist = Math.max(35, dRef.at(-1) * 0.55);
    const finishCandidates = gateGroups(route, finishPoint, Math.min(route.length - 1,s.index + 12), route.length - 1, radius);
    const end = finishCandidates.find(f => f.index > s.index && dUser[f.index] - dUser[s.index] >= minDist && (!Number.isFinite(route[s.index].time) || !Number.isFinite(route[f.index].time) || route[f.index].time - route[s.index].time >= 12000));
    if (!end) continue;
    let previous = s.index;
    const times = [timeAtGate(route,s.index,{lat:ref[0][0],lon:ref[0][1]})];
    const matched = [s.index];
    let missing = 0;
    for (const g of gates.slice(1,-1)) {
      const point = {lat:ref[g.index][0],lon:ref[g.index][1]};
      const hit = gateGroups(route,point,previous+1,end.index-1,radius)[0] || null;
      if (!hit) {times.push(null);matched.push(null);missing++;continue;}
      times.push(timeAtGate(route,hit.index,point));matched.push(hit.index);previous=hit.index;
    }
    const endTime = timeAtGate(route,end.index,finishPoint);
    times.push(endTime);matched.push(end.index);
    const splits = times.slice(1).map((v,i) => v !== null && times[i] !== null && v >= times[i] ? (v - times[i]) / 1000 : null);
    let outside = 0, poorZone = 0, sampled = 0, gaps = 0;
    const stride = Math.max(1,Math.ceil((end.index-s.index)/180));
    for (let k=s.index;k<=end.index;k+=stride) {
      const match=proximity(route[k],ref);
      sampled++;
      if(match.meters>30){
        outside++;
        if ((circuit.weakZones || []).some(z => match.index >= z.from && match.index <= z.to)) poorZone++;
      }
    }
    for(let k=s.index+1;k<=end.index;k++){
      if (Number.isFinite(route[k].time) && Number.isFinite(route[k-1].time) && route[k].time-route[k-1].time>5000) gaps++;
    }
    const confidence=sampled ? 1-outside/sampled : 0;
    const ok=missing===0 && confidence>=0.86 && poorZone===0 && gaps===0 && Number.isFinite(times[0]) && Number.isFinite(endTime);
    const issues=[];
    if(missing)issues.push(missing+' puerta(s) de sector no detectadas');
    if(confidence<0.86)issues.push('la traza se separa del circuito');
    if(poorZone)issues.push('desviaciones en zona GPS débil conocida');
    if(gaps)issues.push(gaps+' intervalo(s) sin datos de más de 5 s');
    if(!Number.isFinite(times[0])||!Number.isFinite(endTime))issues.push('no hay marcas de tiempo completas');
    const seconds=Number.isFinite(times[0])&&Number.isFinite(endTime)&&endTime>=times[0]?(endTime-times[0])/1000:null;
    results.push({startIndex:s.index,finishIndex:end.index,seconds,splits,
      confidence,missing,issues,status:ok?'compatible':'revisar',gateIndices:matched});
    cursor=end.index+1;
  }
  return results;
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
