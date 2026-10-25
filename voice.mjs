// DH Trails v0.10 — the gates said out loud while riding (Grabar), for riders with headphones or the phone in a
// bag near the ear: the circuit when the run starts, at each sector gate how far ahead or behind your best run
// you are, and the time at the finish. The app speaks with the phone's own voice (the «Speech» plugin: with
// the screen off too, lowering the music for a moment); a browser, with its own when it has one. The phrases
// are pure functions, tested in Node.
import {T, dec, locale} from './i18n.mjs';

// A number of seconds as it is said: «44», «43,9».
const said = x => Number.isInteger(x) ? String(x) : dec(x);
// A time as it is said: «43,9 segundos», «2 minutos 43,9 segundos» (tenths: the GPS is not finer than that).
export function spokenTime(ms) {
  const tenths = Math.round(ms / 100), minutes = Math.floor(tenths / 600), seconds = (tenths - minutes * 600) / 10;
  const s = T('{s} segundos', {s: said(seconds)});
  return minutes ? (minutes === 1 ? T('1 minuto') : T('{n} minutos', {n: minutes})) + ' ' + s : s;
}

// Your best run on a circuit to measure against: from your stored runs (as /training/runs gives them), the
// fastest whole one with a time for each sector; its time at each gate after the start (ms), the finish last.
export function bestGates(runs, sectors) {
  const whole = runs.filter(r => r.mine !== false && r.gps_status !== 'revisar' && r.elapsed_ms &&
    (r.sector_splits_ms || []).length === sectors + 1 && r.sector_splits_ms.every(x => x !== null));
  if (!whole.length) return null;
  const best = whole.reduce((a, b) => b.elapsed_ms < a.elapsed_ms ? b : a);
  let sum = 0;
  return best.sector_splits_ms.map(x => (sum += x));
}

// Ahead or behind: «vas 1,4 segundos peor que tu mejor tiempo».
function against(ms, bestMs) {
  const delta = Math.round((ms - bestMs) / 100) / 10;
  if (Math.abs(delta) < 0.1) return T('igual que tu mejor tiempo');
  return Math.abs(delta) === 1 ? T(delta > 0 ? '1 segundo peor que tu mejor tiempo' : '1 segundo mejor que tu mejor tiempo') :
    T(delta > 0 ? '{s} segundos peor que tu mejor tiempo' : '{s} segundos mejor que tu mejor tiempo', {s: said(Math.abs(delta))});
}

// What to say at a gate crossed while riding: `e` from recorder.mjs's liveTimer, `ms` the run's time when it is
// the finish, `best` from bestGates (or null).
export function gatePhrase(e, circuitName, best, ms = e.elapsed) {
  if (e.kind === 'start') return T('Empieza {circuit}.', {circuit: circuitName});
  if (e.kind === 'sector') {
    const bestMs = best?.[e.gate - 1];
    return T('Sector {n}.', {n: e.gate}) + ' ' + (bestMs ? T('Vas {versus}.', {versus: against(e.elapsed, bestMs)}) : spokenTime(e.elapsed) + '.');
  }
  const bestMs = best?.at(-1);
  return T('Fin de {circuit}.', {circuit: circuitName}) + ' ' + T('Tu tiempo ha sido {time}.', {time: spokenTime(ms)}) +
    (bestMs ? ' ' + (ms < bestMs - 50 ? T('¡Nuevo récord! {versus}.', {versus: against(ms, bestMs)}) : capital(against(ms, bestMs)) + '.') : '');
}
const capital = text => text.charAt(0).toUpperCase() + text.slice(1);

// Say it: the app's own voice, else the browser's, else nothing (the beeps still sound).
const cap = globalThis.window?.Capacitor;
const native = cap?.isNativePlatform?.() && cap.PluginHeaders?.some(p => p.name === 'Speech');
export function speak(text) {
  if (!text) return;
  if (native) return cap.nativePromise('Speech', 'speak', {text, lang: locale}).catch(() => {});
  const synth = globalThis.speechSynthesis;
  if (!synth) return;
  const said = new SpeechSynthesisUtterance(text);
  said.lang = locale;
  synth.speak(said);
}
// Browsers only let a page speak after a tap: called on one (starting to record), so it can speak later.
export function unlockVoice() {
  if (native || !globalThis.speechSynthesis) return;
  const quiet = new SpeechSynthesisUtterance('');
  quiet.volume = 0;
  globalThis.speechSynthesis.speak(quiet);
}
