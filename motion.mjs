// DH Trails v0.9 — what the body of a run felt: shocks, jumps and how rough each stretch of the circuit
// was, from an accelerometer. The phone's (recorded by the app with the ride: the «DHS1» file that
// backend/app/sensors.py describes) and a GoPro's (gopro.mjs) follow the same rules. Pure functions,
// tested in Node.
import {T} from './i18n.mjs';
import {timeAt, positionAt} from './telemetry.mjs';

const MAGIC = 'DHS1';
const G = 9.80665;

// The phone's file as the app sent it (gzip from Android, raw deflate from iPhone, or as it was).
export async function inflateMotion(buffer) {
  const head = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  if (String.fromCharCode(...head) === MAGIC) return buffer;
  const format = head[0] === 0x1f && head[1] === 0x8b ? 'gzip' : 'deflate-raw';
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream(format))).arrayBuffer();
}

// The phone's file read: {start (ms since 1970), t (ms from the start), g (total acceleration, in g),
// pressure: [[ms from the start, hPa]]}. Only the size of the acceleration is kept: the phone can sit
// any way round in a pocket or a bag.
export function readMotion(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < 16 || String.fromCharCode(...new Uint8Array(buffer, 0, 4)) !== MAGIC || view.getUint8(4) !== 1)
    throw new Error(T('El archivo de sensores no es válido.'));
  const out = {start: view.getFloat64(8, true), t: [], g: [], pressure: []};
  for (let pos = 16; pos < view.byteLength;) {
    const kind = view.getUint8(pos++);
    if (kind === 1 && pos + 16 <= view.byteLength) {
      out.t.push(view.getUint32(pos, true));
      out.g.push(Math.hypot(view.getInt16(pos + 4, true), view.getInt16(pos + 6, true), view.getInt16(pos + 8, true)) / 100 / G);
      pos += 16;
    } else if (kind === 2 && pos + 8 <= view.byteLength) {
      out.pressure.push([view.getUint32(pos, true), view.getFloat32(pos + 4, true)]);
      pos += 8;
    } else throw new Error(T('El archivo de sensores no es válido.'));
  }
  return out;
}

// Shocks and jumps between two moments, from the total acceleration ({t, g}: seconds and g):
// - shock: 4 g or more (a landing, a root, a rock), at most one a second;
// - air: under 0.35 g for 0.2 s or more (falling with the rider: a jump or a drop).
// The thresholds come from real GoPro runs: on trails ridden at 20-30 km/h shocks reach 4-11 g, and a
// smooth run never stays under 0.35 g for 0.2 s.
export function shocksAndAir({t, g}, from, to) {
  const out = [];
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

// The phone's moment (ms from its start) of a run's moment (ms from the run's start, at `startedMs`).
const phoneMs = (motion, startedMs, ms) => startedMs + ms - motion.start;

// The shocks and jumps of a run, each with its second from the run's start and the metres down the
// circuit where it happened (`profile` is the run's, from timing.py; `startedMs` its start, ms since 1970).
export function runMoments(motion, profile, startedMs) {
  const seconds = {t: motion.t.map(ms => (ms - phoneMs(motion, startedMs, 0)) / 1000), g: motion.g};
  return shocksAndAir(seconds, 0, profile.at(-1)[1] / 1000).map(m => ({...m, s: positionAt(profile, m.t * 1000).s}));
}

// How rough each `step` metres of the circuit were on a run: how much the acceleration shakes (its
// standard deviation, in g) while the run goes through them, and its peak. Null where the phone has no
// readings. Only comparable between runs with the phone carried the same way (a pocket damps it).
export function roughness(motion, profile, startedMs, step = 25) {
  const {t, g} = motion, length = profile.at(-1)[0], out = [];
  let i = 0;
  for (let from = 0; from < length; from += step) {
    const to = Math.min(length, from + step);
    const a = phoneMs(motion, startedMs, timeAt(profile, from)), b = phoneMs(motion, startedMs, timeAt(profile, to));
    while (i < t.length && t[i] < a) i++;
    let n = 0, sum = 0, squares = 0, peak = 0;
    for (let k = i; k < t.length && t[k] < b; k++) {n++; sum += g[k]; squares += g[k] * g[k]; peak = Math.max(peak, g[k]);}
    const mean = n ? sum / n : 0;
    out.push({from, to, shake: n >= 10 ? Math.sqrt(Math.max(0, squares / n - mean * mean)) : null, peak: n >= 10 ? peak : null});
  }
  return out;
}
