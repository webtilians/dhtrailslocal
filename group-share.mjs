// DH Trails — sharing the rider's location with their groups (grupos.mjs, and grabar.mjs while recording):
// how far another rider is and which way, and when to send the phone's place again. The server keeps only
// the last one (backend: app/groups.py).
import {haversine} from './gps-engine.mjs';
import {T, dec} from './i18n.mjs';

// "35 m", "340 m", "1,2 km", "14 km".
export function distanceText(metres) {
  if (metres < 100) return Math.round(metres) + ' m';
  if (metres < 1000) return Math.round(metres / 10) * 10 + ' m';
  return (metres < 10000 ? dec(metres / 1000, 1) : String(Math.round(metres / 1000))) + ' km';
}

// "ahora", "hace 3 min", "hace 2 h".
export function ageText(seconds) {
  if (seconds < 60) return T('ahora');
  if (seconds < 3600) return T('hace {n} min', {n: Math.floor(seconds / 60)});
  return T('hace {n} h', {n: Math.floor(seconds / 3600)});
}

// The way from one place to another, in degrees from north (0-360).
export function bearing(a, b) {
  const rad = Math.PI / 180;
  const p = a.lat * rad, q = b.lat * rad, dl = (b.lon - a.lon) * rad;
  const y = Math.sin(dl) * Math.cos(q), x = Math.cos(p) * Math.sin(q) - Math.sin(p) * Math.cos(q) * Math.cos(dl);
  return (Math.atan2(y, x) / rad + 360) % 360;
}
const POINTS = [['↑', 'al norte'], ['↗', 'al noreste'], ['→', 'al este'], ['↘', 'al sureste'],
  ['↓', 'al sur'], ['↙', 'al suroeste'], ['←', 'al oeste'], ['↖', 'al noroeste']];
// {arrow: '↗', name: 'al noreste'} (in the page's language).
export function compass(degrees) {
  const [arrow, name] = POINTS[Math.round(degrees / 45) % 8];
  return {arrow, name: T(name)};
}

// How far another rider (or a meeting point) is from you and which way ("340 m ↗ al noreste"), how much
// higher or lower ("45 m más abajo", or null), and both together. Null without both places.
export function whereFrom(me, other) {
  if (!me || !other) return null;
  const metres = haversine(me, other), way = compass(bearing(me, other));
  // Closer than the GPS can tell, the way is not told either.
  const distance = distanceText(metres) + (metres >= 15 ? ' ' + way.arrow + ' ' + way.name : '');
  let climb = null;
  if (me.ele != null && other.ele != null) {
    const up = Math.round(other.ele - me.ele);
    // The GPS height is a few metres off: smaller differences are not told.
    if (up >= 15) climb = T('{n} m más arriba', {n: up});
    else if (up <= -15) climb = T('{n} m más abajo', {n: -up});
  }
  return {metres, distance, climb, text: climb ? distance + ' · ' + climb : distance};
}

// Whether a new fix goes to the server: one every 15 s, or after 5 s when the rider has moved 30 m since the
// last one sent. Fixes worse than 150 m are left out unless nothing better has gone for a minute.
export function shouldSend(last, fix, now) {
  if (fix.accuracy > 150 && last && now - last.at < 60000) return false;
  if (!last) return true;
  const since = now - last.at;
  return since >= 15000 || (since >= 5000 && haversine(last, fix) >= 30);
}

// Sends the phone's fixes to the groups the rider shares their location with, no more often than needed.
// `onStopped` is told when the server says the rider no longer shares it with any group.
export function locationSender(api, {onStopped = () => {}, onError = () => {}, clock = Date.now} = {}) {
  let last = null, busy = false, stopped = false;
  return {
    get stopped() {return stopped;},
    // Sharing again (or with another group): the next fix goes at once.
    reset() {stopped = false; last = null;},
    async add(fix) {
      const now = clock();
      if (stopped || busy || !shouldSend(last, fix, now)) return false;
      busy = true;
      try {
        await api.sendLocation({lat: fix.lat, lon: fix.lon, ele: fix.ele ?? null,
          accuracy: fix.accuracy ?? null, speed: fix.speed > 0 ? fix.speed : null});
        last = {lat: fix.lat, lon: fix.lon, at: now};
        return true;
      } catch (err) {
        if (err.status === 409) {stopped = true; onStopped();}
        else if (err.status !== 429) onError(err);
        return false;
      } finally {busy = false;}
    },
  };
}

// For Grabar: a sender when the rider shares their location with some group (null otherwise), and the
// names of those groups.
export async function sharingSender(api, options) {
  const groups = (await api.groups().catch(() => null))?.groups?.filter(g => g.sharing) || [];
  return groups.length ? {sender: locationSender(api, options), groups: groups.map(g => g.name)} : null;
}
