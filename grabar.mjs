// DH Trails v0.8 — Grabar: a ride recorded with the phone's GPS, with the time at the gates while riding.
// In the app for Android and iPhone the GPS goes on with the screen off (a native plugin, Capacitor's
// BackgroundGeolocation); in a browser only while the page is on screen, which is then kept awake.
import {formatMs} from './sector-comparison.mjs';
import {detectAttempts, haversine} from './gps-engine.mjs';
import {liveTimer, nearestStart, rideGpx} from './recorder.mjs';
import {beep, unlockSound} from './gate-sounds.mjs';
import {$, node, say, startShell, km} from './app-shell.mjs';
import {T, locale, tServer} from './i18n.mjs';

const KEY = 'dhtrails:grabacion';
// The app's native GPS plugin, called through the bridge Capacitor puts in the page (the page comes from
// the server, without Capacitor's own JavaScript).
const cap = window.Capacitor;
const native = cap?.isNativePlatform?.() && cap.PluginHeaders?.some(p => p.name === 'BackgroundGeolocation') ? {
  addWatcher: (options, callback) => cap.nativeCallback('BackgroundGeolocation', 'addWatcher', options, callback),
  removeWatcher: options => cap.nativePromise('BackgroundGeolocation', 'removeWatcher', options),
  openSettings: () => cap.nativePromise('BackgroundGeolocation', 'openSettings', {}),
} : null;
const POOR_M = 35;          // fixes less precise than this are not used for the time
const NEAR_M = 3000;        // «automatic» takes the nearest circuit whose start is this close
let shell = null, catalog = [], fixes = [], stopWatch = null, wakeLock = null, ticker = 0;
let circuit = null, timer = null, lastFix = null, finished = [];
const status = (message, type = '') => say($('status'), message, type);

// ---- The recording, kept on the device while it goes on (a reload or a crash does not lose it)
const save = () => {try {localStorage.setItem(KEY, JSON.stringify({fixes}));} catch {}};
const kept = () => {try {return JSON.parse(localStorage.getItem(KEY))?.fixes || [];} catch {return [];}};
const forget = () => {try {localStorage.removeItem(KEY);} catch {}};

// ---- The GPS: the native plugin in the app, the browser's elsewhere
async function watch(onFix, onError) {
  if (native) {
    const id = await native.addWatcher({backgroundTitle: 'DH Trails', backgroundMessage: T('Grabando tu bajada'),
      requestPermissions: true, stale: false, distanceFilter: 0}, (location, error) => {
      if (error) return onError(error);
      onFix({lat: location.latitude, lon: location.longitude, ele: location.altitude ?? null, accuracy: location.accuracy,
        speed: location.speed ?? null, time: location.time || Date.now()});
    });
    return () => native.removeWatcher({id});
  }
  const id = navigator.geolocation.watchPosition(p => onFix({lat: p.coords.latitude, lon: p.coords.longitude,
    ele: p.coords.altitude, accuracy: p.coords.accuracy, speed: p.coords.speed, time: p.timestamp}), onError,
    {enableHighAccuracy: true, maximumAge: 0, timeout: 30000});
  return () => navigator.geolocation.clearWatch(id);
}
// In a browser the screen stays on while recording: the GPS stops when it goes off.
async function keepAwake() {
  if (native || !navigator.wakeLock) return;
  try {wakeLock = await navigator.wakeLock.request('screen');} catch {}
}
document.addEventListener('visibilitychange', () => {if (stopWatch && document.visibilityState === 'visible') keepAwake();});

// ---- The circuit: the one chosen, or the one whose start is nearest
function pickCircuit(at) {
  const id = $('circuit').value;
  const next = id ? catalog.find(c => c.id === id) : (() => {const n = nearestStart(catalog, at); return n && n.metres <= NEAR_M ? n.circuit : null;})();
  if (next !== circuit) {circuit = next; timer = circuit ? liveTimer(circuit, {radius: circuit.gateRadius || 18}) : null;}
}

function onFix(fix) {
  lastFix = fix;
  fixes.push(fix);
  if (fixes.length % 5 === 0) save();
  $('gpsTag').textContent = 'GPS ±' + Math.round(fix.accuracy || 0) + ' m';
  if (fix.accuracy > POOR_M) return show();
  if (!timer?.running) pickCircuit(fix);
  for (const e of timer ? timer.add(fix) : []) {
    if (e.kind === 'start') {beep('line'); $('splits').replaceChildren();}
    else if (e.kind === 'sector') {beep('sector'); addSplit('S' + e.gate, e.split, e.elapsed);}
    else {beep('line'); finish(e);}
  }
  show();
}
function onError(error) {
  const denied = error?.code === 1 || error?.code === 'NOT_AUTHORIZED' || /denied|permission/i.test(error?.message || '');
  status(denied ? T('Sin permiso para usar el GPS. Actívalo en los ajustes del móvil para esta app o este navegador.') :
    T('El GPS no responde: {error}', {error: error?.message || error}), 'error');
  if (denied && native && window.confirm(T('¿Abrir los ajustes de la app para dar permiso al GPS?'))) native.openSettings();
}

function addSplit(label, split, elapsed) {
  $('splits').append(node('div', {className: 'rec-split'}, [node('b', {textContent: label}),
    node('span', {textContent: formatMs(split)}), node('small', {textContent: formatMs(elapsed)})]));
}
// The finish: the time while riding, then the one the server's engine would give from the whole ride.
function finish(e) {
  addSplit(T('Meta'), e.split, e.elapsed);
  const route = fixes.filter(f => !(f.accuracy > POOR_M)).map(f => ({lat: f.lat, lon: f.lon, ele: f.ele ?? null, time: f.time}));
  const run = detectAttempts(route, circuit).at(-1);
  const ms = run?.seconds ? run.seconds * 1000 : e.elapsed;
  finished.push({circuit: circuit.name, ms, ok: !run || run.status === 'compatible'});
  status(T('¡Meta en {circuit}! {time}. El tiempo oficial lo calcula el servidor al guardar.', {circuit: circuit.name, time: formatMs(ms)}), 'success');
}

// ---- What the screen says while recording
function show() {
  const recording = !!stopWatch, signedIn = !!shell?.me;
  $('startRec').hidden = recording;
  // A ride is recorded to go to the rider's Entrenamiento: first, the account.
  $('startRec').textContent = signedIn ? '● ' + T('Empezar a grabar') : T('Entra para grabar');
  if (!recording && !fixes.length) $('state').textContent = signedIn ? T('Pulsa «Empezar a grabar» cuando estés listo.') :
    T('Entra con tu cuenta para grabar: tus bajadas se guardan en tu Entrenamiento.');
  $('stopRec').hidden = !recording && !fixes.length;
  $('discard').hidden = !fixes.length;
  $('stopRec').textContent = recording ? '■ ' + T('Terminar y guardar') : T('Guardar la grabación');
  $('circuit').disabled = !!timer?.running;
  const running = !!timer?.running;
  $('clock').hidden = !running && !finished.length;
  if (!recording) return;
  const metres = lastFix && circuit ? Math.round(haversine(circuit.points[0], lastFix)) : null;
  $('state').textContent = !lastFix ? T('Buscando señal GPS…') :
    lastFix.accuracy > POOR_M ? T('GPS poco preciso (±{m} m): espera a cielo abierto un momento.', {m: Math.round(lastFix.accuracy)}) :
    running ? T('En bajada · {circuit} · siguiente: {gate}', {circuit: circuit.name,
      gate: timer.nextGate === timer.gates.length - 1 ? T('Meta') : 'S' + timer.nextGate}) :
    !circuit ? T('No hay ningún circuito cerca: se graba igual, y al guardar se buscan todos.') :
    metres > 25 ? T('Ve a la salida de {circuit}: está a {distance}.', {circuit: circuit.name, distance: metres >= 1000 ? km(metres) : metres + ' m'}) :
    T('En la salida de {circuit}: arranca cuando quieras.', {circuit: circuit.name});
  const length = fixes.reduce((sum, f, i) => i ? sum + haversine(fixes[i - 1], f) : 0, 0);
  $('gpsInfo').textContent = T('{n} puntos · {distance} · grabando desde las {time}', {n: fixes.length, distance: km(length),
    time: new Date(fixes[0]?.time || Date.now()).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'})});
}
// The clock runs between fixes, ten times a second.
function tick() {
  const clock = $('clock');
  if (timer?.running) clock.textContent = formatMs(Date.now() - timer.startTime);
  else if (finished.length) clock.textContent = formatMs(finished.at(-1).ms);
}

// ---- Start, stop, save
$('startRec').addEventListener('click', async () => {
  if (!shell?.me) return shell?.askLogin(T('Entra con tu cuenta para grabar: tus bajadas se guardan en tu Entrenamiento.'));
  unlockSound();
  if (!native && !navigator.geolocation) return status(T('Este navegador no da acceso al GPS.'), 'error');
  fixes = kept();
  finished = [];
  $('resultPanel').hidden = true;
  status('');
  try {stopWatch = await watch(onFix, onError);}
  catch (err) {return onError(err);}
  await keepAwake();
  clearInterval(ticker);
  ticker = setInterval(tick, 100);
  show();
});
$('stopRec').addEventListener('click', async () => {
  if (stopWatch) {await stopWatch(); stopWatch = null;}
  clearInterval(ticker);
  try {await wakeLock?.release();} catch {}
  wakeLock = null;
  save();
  show();
  await upload();
});
$('discard').addEventListener('click', async () => {
  if (!window.confirm(T('¿Descartar la grabación? Se pierde lo grabado.'))) return;
  if (stopWatch) {await stopWatch(); stopWatch = null;}
  clearInterval(ticker);
  fixes = []; finished = []; timer = null; circuit = null; lastFix = null;
  forget();
  $('splits').replaceChildren();
  $('state').textContent = T('Pulsa «Empezar a grabar» cuando estés listo.');
  $('gpsInfo').textContent = '';
  show();
});
window.addEventListener('beforeunload', event => {if (stopWatch) {event.preventDefault(); event.returnValue = '';}});

// The ride goes to Entrenamiento like a watch's GPX; its runs can go on to an open time trial.
async function upload() {
  const usable = fixes.filter(f => !(f.accuracy > POOR_M));
  if (usable.length < 10) return status(T('Hay muy pocos puntos con buen GPS para guardar una ruta.'), 'error');
  if (!shell.me) return shell.askLogin(T('Entra con tu cuenta para guardar la grabación. No se pierde: sigue en este móvil.'));
  const stamp = new Date(usable[0].time);
  const name = 'DH Trails ' + stamp.toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
  const file = new File([rideGpx(usable, name)], name.replace(/[^\w-]+/g, '-') + '.gpx', {type: 'application/gpx+xml'});
  status(T('Guardando y buscando tus bajadas…'));
  $('stopRec').disabled = true;
  try {
    const result = await shell.api.uploadTrainingRoute(file);
    forget();
    fixes = [];
    show();
    const open = (await shell.api.tournaments().catch(() => [])).filter(t => t.state === 'activo');
    const lines = result.runs.map(r => node('p', {className: 'report-line', textContent: r.circuit_name + ': ' + formatMs(r.elapsed_ms)}));
    const send = open.filter(t => result.found.some(f => f.circuit_id === t.circuit_id)).map(t => {
      const b = node('button', {type: 'button', className: 'btn outline full', textContent: T('Enviar al time trial «{name}»', {name: t.name})});
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          const entry = await shell.api.submitEntry(t.id, file);
          const time = formatMs(entry.elapsed_ms);
          status(entry.review_status === 'approved' ? T('Bajada aceptada: {time}. Ya estás en la clasificación.', {time}) :
            entry.review_status === 'pending' ? T('Bajada recibida: {time}. La organización la revisará antes de que entre en la clasificación.', {time}) :
            T('La bajada no entra en la clasificación: {why}.', {why: entry.review_note ? tServer(entry.review_note) : T('no pasa el filtro')}),
            {approved: 'success', pending: '', rejected: 'error'}[entry.review_status]);
        } catch (err) {b.disabled = false; status(T('No se ha aceptado la bajada: {error}', {error: err.message}), 'error');}
      });
      return b;
    });
    $('result').replaceChildren(
      node('p', {className: 'help', textContent: result.runs.length ? T('Guardada en Entrenamiento con {n} bajada(s):', {n: result.runs.length}) :
        T('Guardada en Entrenamiento, pero no hay en ella ninguna bajada completa de un circuito.')}),
      ...lines, ...send,
      node('a', {className: 'btn outline full', href: './entrenamiento.html', textContent: T('Ver en Entrenamiento')}),
      node('a', {className: 'btn outline full', href: './circuitos.html?ruta=' + encodeURIComponent(result.activity.id),
        textContent: T('Crear un circuito con esta ruta')}));
    $('resultPanel').hidden = false;
    status(T('Grabación guardada.'), 'success');
    $('resultPanel').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (err) {status(T('No se pudo guardar: {error}', {error: err.message}) + ' ' + T('La grabación sigue en este móvil: vuelve a pulsar Guardar.'), 'error');}
  finally {$('stopRec').disabled = false;}
}

async function start() {
  shell = await startShell('grabar');
  $('screenNote').textContent = native ? T('Puedes bloquear el móvil y guardarlo: la app sigue grabando y lo verás en la notificación.') :
    T('En el navegador, deja la pantalla encendida y esta página delante: si bloqueas el móvil, el GPS se para. Con la app instalada para Android o iPhone sí graba con la pantalla apagada.');
  if (!native) $('screenNote').append(' ', node('a', {href: './app.html', textContent: T('Instalar la app')}));
  if (shell.api) catalog = await shell.api.circuitCatalog().catch(() => []);
  $('circuit').append(...catalog.map(c => node('option', {value: c.id, textContent: c.name})));
  $('circuit').addEventListener('change', () => {circuit = null; timer = null; if (lastFix) pickCircuit(lastFix); show();});
  shell.onUser(() => {show(); if (fixes.length && !stopWatch) status(T('Ya puedes guardar la grabación.'), 'success');});
  // A recording not saved (the page was closed or reloaded): it can be saved or recorded on.
  fixes = kept();
  if (fixes.length) status(T('Hay una grabación sin guardar de las {time} ({n} puntos): guárdala, sigue grabando o descártala.',
    {time: new Date(fixes[0].time).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'}), n: fixes.length}));
  show();
}
start().catch(err => status('Error: ' + err.message, 'error'));
