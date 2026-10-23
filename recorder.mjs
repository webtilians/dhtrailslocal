// DH Trails v0.8 — a ride recorded with the phone's GPS: the gates while riding (start, sectors, finish),
// and the ride as a GPX file afterwards, like a watch's. Pure functions, tested in Node.
import {haversine} from './gps-engine.mjs';

// The circuit whose start is nearest to a place, with how far it is ({circuit, metres}), or null.
export function nearestStart(circuits, at) {
  let best = null;
  for (const circuit of circuits) {
    const metres = haversine(circuit.points[0], at);
    if (!best || metres < best.metres) best = {circuit, metres};
  }
  return best;
}

// A circuit's gates as places, in order: the start, each sector gate, the finish.
export function gatePlaces(circuit) {
  const p = circuit.points;
  return [p[0], ...(circuit.sectors || []).map(s => p[s.index]), p.at(-1)].map(q => ({lat: q[0], lon: q[1]}));
}

// Times at the gates while riding. Fixes go in ({lat, lon, time in ms, speed in m/s or null}); out come the
// gates crossed: {kind: 'start' | 'sector' | 'finish', gate, time, elapsed (ms since the start), split (ms
// since the gate before)}. A gate is crossed at the fix nearest to it within `radius` metres while riding
// (over `minSpeed`: standing at the start does not start the clock), seen once a fix moves away again. The
// gates come in order; one missed (GPS lost under trees) does not stop the one after it or the finish, but
// a gate further on is not taken early where the trail passes near it. Riding back to the start begins
// another run. The official time is the server's, from the whole file.
export function liveTimer(circuit, {radius = 18, minSpeed = 1.5} = {}) {
  const gates = gatePlaces(circuit), last = gates.length - 1;
  let next = 0, startTime = null, gateTime = null, previous = null, leftStart = false;
  let near = gates.map(() => null);   // per gate: the nearest moving fix inside its radius so far
  const crossed = (fix, g, speed) => {
    const metres = haversine(fix, gates[g]);
    const best = near[g];
    if (metres <= radius && speed >= minSpeed && (!best || metres < best.metres)) {near[g] = {metres, fix}; return null;}
    // Moving away from the nearest fix (or out of the circle): that one was the crossing.
    if (best && (metres > best.metres + 2 || metres > radius)) {near[g] = null; return best.fix;}
    return null;
  };
  return {
    get running() {return startTime !== null;},
    get startTime() {return startTime;},
    get nextGate() {return next;},
    gates,
    add(fix) {
      const speed = Number.isFinite(fix.speed) ? fix.speed :
        previous && fix.time > previous.time ? haversine(previous, fix) / ((fix.time - previous.time) / 1000) : 0;
      previous = fix;
      const events = [];
      // The start: before a run, or again once the rider has ridden away from it and comes back.
      if (startTime !== null && haversine(fix, gates[0]) > 2 * radius) leftStart = true;
      const start = startTime === null || leftStart ? crossed(fix, 0, speed) : null;
      if (start) {
        startTime = gateTime = start.time;
        next = 1;
        leftStart = false;
        near = gates.map(() => null);
        events.push({kind: 'start', gate: 0, time: start.time, elapsed: 0, split: 0});
        return events;
      }
      if (startTime === null) return events;
      for (const g of [...new Set([next, Math.min(next + 1, last), last])]) {
        const at = crossed(fix, g, speed);
        if (!at || at.time <= gateTime) continue;
        events.push({kind: g === last ? 'finish' : 'sector', gate: g, time: at.time, elapsed: at.time - startTime, split: at.time - gateTime});
        gateTime = at.time;
        next = g + 1;
        if (g === last) {startTime = null; next = 0; near = gates.map(() => null);}
        break;
      }
      return events;
    },
  };
}

// The ride as a GPX file, with a point every whole second like a watch writes (the phone gives its fixes at
// any millisecond; the server takes fixes off whole seconds for an edited file). Across a gap of more than
// 10 s nothing is made up.
export function rideGpx(fixes, name) {
  const points = [];
  const sorted = [...fixes].sort((a, b) => a.time - b.time);
  let i = 0;
  for (let t = Math.ceil(sorted[0].time / 1000) * 1000; t <= sorted.at(-1).time; t += 1000) {
    while (i + 1 < sorted.length && sorted[i + 1].time <= t) i++;
    const a = sorted[i], b = sorted[Math.min(i + 1, sorted.length - 1)];
    if (a.time === t || b === a) {if (a.time === t) points.push({...a, time: t}); continue;}
    if (b.time - a.time > 10000) continue;
    const f = (t - a.time) / (b.time - a.time);
    const mix = (x, y) => x === null || x === undefined || y === null || y === undefined ? x ?? y ?? null : x + (y - x) * f;
    points.push({lat: mix(a.lat, b.lat), lon: mix(a.lon, b.lon), ele: mix(a.ele, b.ele), time: t});
  }
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<gpx version="1.1" creator="DH Trails (GPS del móvil)" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    `<trk><name>${esc(name)}</name><trkseg>\n` +
    points.map(p => `<trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}">` +
      (Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '') + `<time>${new Date(p.time).toISOString().replace('.000Z', 'Z')}</time></trkpt>`).join('\n') +
    '\n</trkseg></trk>\n</gpx>\n';
}
