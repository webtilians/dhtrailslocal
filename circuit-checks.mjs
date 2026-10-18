// DH Trails — checks on a circuit before it is saved: what would make its timing unreliable, and what
// the organizer should know about other circuits on the same trail. Only warnings and notes, never a
// block: whoever draws the circuit knows the trail.
import {distanceSeries, haversine} from './gps-engine.mjs';

const GATE_M = 18;       // the gates' radius (buildCircuit)
const NEAR_M = GATE_M + 7;
const m = metres => Math.round(metres) + ' m';

// Metres from p to the nearest point of a circuit's line (its points come every few metres).
function offLine(p, points) {
  let best = Infinity;
  for (const q of points) {
    if (Math.abs(q[0] - p.lat) > 0.002 || Math.abs(q[1] - p.lon) > 0.0025) continue;
    best = Math.min(best, haversine(p, q));
  }
  return best;
}

// route: [{lat, lon, ele}] as imported; start, finish: its indices; gates: [{index}] in between;
// others: the saved circuits, [{name, points: [[lat, lon, ele]]}].
// [{level: 'warning' | 'info', text}]: warnings for the timing, notes for the organizer.
export function circuitChecks(route, start, finish, gates = [], others = []) {
  const line = route.slice(start, finish + 1), d = distanceSeries(line), length = d.at(-1), out = [];
  const warn = text => out.push({level: 'warning', text}), note = text => out.push({level: 'info', text});

  // Downhill: the finish lower than the start.
  const [top, bottom] = [line[0].ele, line.at(-1).ele];
  if (Number.isFinite(top) && Number.isFinite(bottom) && bottom > top + 5)
    warn('La meta está ' + m(bottom - top) + ' más alta que la salida: ¿están la salida y la meta al revés?');
  if (length < 150) warn('Mide solo ' + m(length) + ': en tan poco recorrido, cada error del GPS pesa mucho en el tiempo.');
  const ends = haversine(line[0], line.at(-1));
  if (ends < 3 * GATE_M) warn('La salida y la meta están a ' + m(ends) + ': al pasar por una se puede marcar la otra.');

  // The line coming back by the start, or by the finish before reaching it, or by a segment's end in a
  // hairpin: a run could be timed from or to the wrong pass.
  const again = (at, label, after) => {
    let i = -1;
    line.forEach((p, k) => {
      if (Math.abs(d[k] - d[at]) > 60 && (after === undefined || (after ? k > at : k < at)) && haversine(p, line[at]) < NEAR_M &&
        (i < 0 || haversine(p, line[at]) < haversine(line[i], line[at]))) i = k;
    });
    if (i >= 0) warn(label + ' está a ' + m(haversine(line[i], line[at])) + ' de otro paso del trazado (metro ' + m(d[i]) +
      '): el GPS puede confundir los dos pasos. Si puedes, muévelo a un punto sin otro tramo cerca.');
  };
  again(0, 'La salida', true);
  again(line.length - 1, 'La meta', false);
  const bounds = [0, ...gates.map(g => g.index - start).filter(i => i > 0 && i < line.length - 1).sort((a, b) => a - b), line.length - 1];
  bounds.slice(1, -1).forEach((at, k) => again(at, 'El fin del segmento ' + (k + 1)));
  bounds.slice(1).forEach((at, k) => {
    const span = d[at] - d[bounds[k]];
    if (span < 30) warn('El segmento ' + (k + 1) + ' mide solo ' + m(span) + ': un reloj apenas da un par de puntos en él.');
  });

  // The GPS of the route the circuit is drawn from: holes (a straight line where the trail may turn)
  // and single points thrown off the trail.
  const spikes = [];
  for (let i = 1; i < line.length - 1; i++) {
    const through = haversine(line[i - 1], line[i]) + haversine(line[i], line[i + 1]), direct = haversine(line[i - 1], line[i + 1]);
    if (through > 2.5 * direct + 25) spikes.push(i);
  }
  if (spikes.length) warn('Posible salto del GPS en el metro ' + spikes.slice(0, 3).map(i => m(d[i - 1])).join(', ') +
    ': un punto se va fuera del sendero y vuelve. La línea del circuito pasaría por él.');
  let hole = 0, gap = 0;
  for (let i = 1; i < line.length; i++) {
    const step = spikes.includes(i) || spikes.includes(i - 1) ? 0 : haversine(line[i - 1], line[i]);
    if (step > gap) {gap = step; hole = i;}
  }
  if (gap > 40) warn('Hay un hueco de ' + m(gap) + ' sin puntos en el metro ' + m(d[hole - 1]) +
    ': ahí la línea va recta. Si el sendero gira, mejor dibujarlo con otra ruta de mejor GPS.');

  // Other circuits on the same trail.
  const sample = [];
  let next = 0;
  line.forEach((p, k) => {if (d[k] >= next) {sample.push(p); next = d[k] + 10;}});
  for (const other of others) {
    const pts = other.points;
    if (!pts?.length) continue;
    const toStart = {lat: pts[0][0], lon: pts[0][1]}, toFinish = {lat: pts.at(-1)[0], lon: pts.at(-1)[1]};
    if (haversine(line[0], toStart) < 30 && haversine(line.at(-1), toFinish) < 30) {
      warn('Parece el mismo circuito que «' + other.name + '»: tiene la misma salida y la misma meta.');
      continue;
    }
    const shared = sample.filter(p => offLine(p, pts) < 15).length / sample.length;
    if (shared >= 0.5) note('Comparte el ' + Math.round(shared * 100) + ' % del trazado con «' + other.name + '».');
    else {
      const on = [offLine(line[0], pts) < 20 && 'la salida', offLine(line.at(-1), pts) < 20 && 'la meta'].filter(Boolean);
      if (on.length) note(on.join(' y ').replace(/^./, c => c.toUpperCase()) + (on.length > 1 ? ' están' : ' está') + ' sobre el circuito «' +
        other.name + '»: sus bajadas pasan por aquí. No se mezclan: una bajada solo cuenta en un circuito si sigue al menos el 85 % de su trazado.');
    }
  }
  return out;
}
