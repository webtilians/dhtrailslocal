// DH Trails v0.8 — Grabar: a ride recorded with the phone's GPS, with the time at the gates while riding.
// In the app for Android and iPhone the GPS goes on with the screen off (a native plugin, Capacitor's
// BackgroundGeolocation); in a browser only while the page is on screen, which is then kept awake.
import {formatMs} from './sector-comparison.mjs';
import {detectAttempts, haversine} from './gps-engine.mjs';
import {approachWatch, circuitsNear, liveTimer, nearestStart, rideGpx} from './recorder.mjs';
import {beep, unlockSound} from './gate-sounds.mjs';
import {bestGates, gatePhrase, speak, unlockVoice} from './voice.mjs';
import {$, node, say, startShell, km, createMap, pin, drawCircuit} from './app-shell.mjs';
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
// The phone's other sensors (accelerometer, gyroscope, barometer), recorded by the app's native side next to
// the GPS and uploaded by it with the ride; null in a browser.
const motion = cap?.isNativePlatform?.() && cap.PluginHeaders?.some(p => p.name === 'MotionRecorder') ? {
  start: options => cap.nativePromise('MotionRecorder', 'start', options),
  stop: () => cap.nativePromise('MotionRecorder', 'stop', {}),
  upload: options => cap.nativePromise('MotionRecorder', 'upload', options),
  discard: () => cap.nativePromise('MotionRecorder', 'discard', {}),
} : null;
let sensors = null;   // which ones the phone has, once recording
const POOR_M = 35;          // fixes less precise than this are not used for the time
const NEAR_M = 3000;        // «automatic» takes the nearest circuit whose start is this close
let shell = null, catalog = [], fixes = [], stopWatch = null, wakeLock = null, ticker = 0;
let circuit = null, timer = null, lastFix = null, finished = [], approach = null;
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
  if (next !== circuit) {circuit = next; timer = circuit ? liveTimer(circuit, {radius: circuit.gateRadius || 18}) : null; if (circuit) bestOf(circuit); drawTimed();}
}

// ---- The map while recording: the way ridden so far, where you are, the circuit being timed and, when
// asked, the circuits around. It follows you until you move it.
let view = null, ridden = null, here = null, timedLayer = null, nearLayer = null, following = true;
const good = f => !(f.accuracy > POOR_M);
const into = group => ({add: layer => {group.addLayer(layer); return layer;}, fit() {}});
function openMap() {
  $('recMapBox').hidden = false;
  if (!view) {
    view = createMap('recMap');
    view.map.on('dragstart', () => {following = false; $('followMe').hidden = false;});
    timedLayer = view.add(L.layerGroup());
    nearLayer = view.add(L.layerGroup());
    // The way ridden in white over a dark edge (seen on the map and on the satellite).
    ridden = [view.add(L.polyline([], {color: '#06121e', weight: 8, opacity: .85, interactive: false})),
      view.add(L.polyline([], {color: '#ffffff', weight: 4, opacity: 1, interactive: false}))];
  }
  const way = fixes.filter(good).map(f => [f.lat, f.lon]);
  ridden.forEach(line => line.setLatLngs(way));
  drawTimed();
  setTimeout(() => {
    view.map.invalidateSize();
    if (way.length) view.map.setView(way.at(-1), Math.max(view.map.getZoom(), 16));
  }, 60);
}
function closeMap() {
  $('recMapBox').hidden = true;
  nearLayer?.clearLayers();
  $('nearList').replaceChildren();
  if (here) {view.map.removeLayer(here); here = null;}
}
function mapFix(fix) {
  if (!view || !good(fix)) return;
  ridden.forEach(line => line.addLatLng([fix.lat, fix.lon]));
  if (here) here.setLatLng([fix.lat, fix.lon]);
  else here = view.add(L.circleMarker([fix.lat, fix.lon], {radius: 8, color: '#06121e', weight: 3, fillColor: '#ffe066', fillOpacity: 1, interactive: false}));
  if (following) view.map.setView([fix.lat, fix.lon], Math.max(view.map.getZoom(), 15), {animate: false});
}
// The circuit being timed (or about to be): its line, start, sector gates and finish.
function drawTimed() {
  if (!timedLayer) return;
  timedLayer.clearLayers();
  if (circuit) drawCircuit(into(timedLayer), circuit, {fit: false});
  onTop();
}
// The way ridden and where you are stay over the circuits drawn after them.
function onTop() {
  ridden?.forEach(line => line.bringToFront());
  here?.bringToFront();
}
$('followMe').addEventListener('click', () => {
  following = true;
  $('followMe').hidden = true;
  if (lastFix) view.map.setView([lastFix.lat, lastFix.lon], Math.max(view.map.getZoom(), 16));
});
// The circuits whose start is within 5 km: on the map with their names, and as a list to pick one.
$('findCircuits').addEventListener('click', () => {
  const at = lastFix && good(lastFix) ? lastFix : null;
  if (!at) return status(T('Espera a tener señal GPS para buscar los circuitos cercanos.'), 'warning');
  const near = circuitsNear(catalog, at);
  nearLayer.clearLayers();
  if (!near.length) return $('nearList').replaceChildren(node('p', {className: 'placeholder', textContent: T('No hay ningún circuito a menos de 5 km.')}));
  for (const {circuit: c} of near) {
    const pts = c.points.map(p => [p[0], p[1]]);
    nearLayer.addLayer(L.polyline(pts, {color: '#8faac4', weight: 5, opacity: .85}));
    pin(into(nearLayer), pts[0], 'start', T('Salida de {circuit}', {circuit: c.name}));
    nearLayer.addLayer(L.tooltip({permanent: true, direction: 'right', offset: [14, 0], className: 'near-label'})
      .setLatLng(pts[0]).setContent(node('span', {textContent: c.name})));
  }
  onTop();
  following = false;
  $('followMe').hidden = false;
  view.fit([[at.lat, at.lon], ...near.map(x => x.circuit.points[0].slice(0, 2))], 40);
  $('nearList').replaceChildren(...near.map(({circuit: c, metres}) => {
    const choose = node('button', {type: 'button', className: 'btn outline small', textContent: T('Elegir')});
    choose.addEventListener('click', () => {
      if (timer?.running) return status(T('Termina esta bajada antes de elegir otro circuito.'), 'warning');
      $('circuit').value = c.id;
      $('circuit').dispatchEvent(new Event('change'));
      status(T('Elegido {circuit}: ve a su salida.', {circuit: c.name}), 'success');
    });
    return node('div', {className: 'item'}, [node('span', {}, [node('b', {textContent: c.name}),
      node('small', {textContent: ' · ' + T('salida a {distance}', {distance: metres >= 1000 ? km(metres) : Math.round(metres) + ' m'})})]), choose]);
  }));
});
// Riding up to a circuit's start (50 m): a beep, the voice if on, and a line on the screen; not mid-run.
function arriving(fix) {
  for (const {circuit: c, metres} of approach ? approach.add(fix) : []) {
    if (timer?.running) continue;
    beep('sector');
    status(T('Estás llegando a {circuit}: la salida está a {m} m.', {circuit: c.name, m: Math.round(metres)}), 'success');
    if (voiceOn()) speak(T('Estás llegando a {circuit}.', {circuit: c.name}));
  }
}
// Spoken gates (voice.mjs): your best run on each circuit, fetched once, to say how far ahead or behind you are.
const bests = new Map();
function bestOf(c) {
  if (!bests.has(c.id)) bests.set(c.id, shell?.me ? shell.api.trainingRuns(c.id).then(runs => bestGates(runs, (c.sectors || []).length))
    .catch(() => null) : Promise.resolve(null));
  return bests.get(c.id);
}
const voiceOn = () => $('voice').checked;
const VOICE_KEY = 'dhtrails:voz';
try {$('voice').checked = localStorage.getItem(VOICE_KEY) !== 'no';} catch {}
$('voice').addEventListener('change', () => {try {localStorage.setItem(VOICE_KEY, $('voice').checked ? 'si' : 'no');} catch {} if ($('voice').checked) unlockVoice();});
async function sayGate(e, ms) {
  if (!voiceOn() || !circuit) return;
  const name = circuit.name;
  speak(gatePhrase(e, name, await bestOf(circuit), ms));
}

function onFix(fix) {
  lastFix = fix;
  fixes.push(fix);
  if (fixes.length % 5 === 0) save();
  $('gpsTag').textContent = 'GPS ±' + Math.round(fix.accuracy || 0) + ' m';
  if (fix.accuracy > POOR_M) return show();
  mapFix(fix);
  arriving(fix);
  if (!timer?.running) pickCircuit(fix);
  for (const e of timer ? timer.add(fix) : []) {
    if (e.kind === 'start') {beep('line'); $('splits').replaceChildren(); sayGate(e);}
    else if (e.kind === 'sector') {beep('sector'); addSplit('S' + e.gate, e.split, e.elapsed); sayGate(e);}
    else {beep('line'); sayGate(e, finish(e));}
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
  return ms;
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
    time: new Date(fixes[0]?.time || Date.now()).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'})}) +
    (sensors ? ' · ' + T('sensores: {list}', {list: [sensors.accelerometer && T('acelerómetro'), sensors.gyroscope && T('giroscopio'),
      sensors.barometer && T('barómetro')].filter(Boolean).join(', ')}) : '');
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
  if (voiceOn()) unlockVoice();
  if (!native && !navigator.geolocation) return status(T('Este navegador no da acceso al GPS.'), 'error');
  fixes = kept();
  finished = [];
  $('resultPanel').hidden = true;
  status('');
  // A recording kept from before goes on in the same sensors' file; a new one starts it again, so sensors
  // left from an earlier ride go to the server first.
  if (!fixes.length) await resendSensors();
  try {stopWatch = await watch(onFix, onError);}
  catch (err) {return onError(err);}
  openMap();
  $('recMapBox').scrollIntoView({behavior: 'smooth', block: 'start'});
  sensors = motion ? await motion.start({hz: 100, append: fixes.length > 0}).catch(() => null) : null;
  if (motion && !sensors) status(T('El móvil no deja leer sus sensores: esta vez solo se graba el GPS.'), 'warning');
  await keepAwake();
  clearInterval(ticker);
  ticker = setInterval(tick, 100);
  show();
});
$('stopRec').addEventListener('click', async () => {
  if (stopWatch) {await stopWatch(); stopWatch = null;}
  await motion?.stop().catch(() => {});
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
  fixes = []; finished = []; timer = null; circuit = null; lastFix = null; sensors = null;
  forget();
  closeMap();
  await motion?.discard().catch(() => {});
  $('splits').replaceChildren();
  $('state').textContent = T('Pulsa «Empezar a grabar» cuando estés listo.');
  $('gpsInfo').textContent = '';
  show();
});
window.addEventListener('beforeunload', event => {if (stopWatch) {event.preventDefault(); event.returnValue = '';}});

// The sensors go with the ride just saved; if they cannot go, the ride stays saved without them.
async function uploadSensors(routeId) {
  if (!motion) return;
  try {
    const sent = await motion.upload({url: location.origin + '/api/training/routes/' + encodeURIComponent(routeId) + '/sensors',
      token: shell.api.sessionToken()});
    if (sent?.status === 200) await motion.discard();
    else status(T('La ruta se ha guardado, pero los datos de los sensores no han podido subirse.'), 'warning');
  } catch {status(T('La ruta se ha guardado, pero los datos de los sensores no han podido subirse.'), 'warning');}
  sensors = null;
}

// Sensors left on the phone, with no recording going on, are those of a ride whose upload failed (the
// server down, no signal): they go now, and the server puts them with your route of their time. Kept for
// later if the server cannot be reached; dropped if it has no route for them or refuses them.
let resending = null;
function resendSensors() {
  return resending ??= (async () => {
    if (!motion || stopWatch || kept().length || !shell?.me) return;
    const left = await motion.stop().catch(() => null);
    if (!(left?.bytes > 16)) return;
    try {
      const sent = await motion.upload({url: location.origin + '/api/training/sensors', token: shell.api.sessionToken()});
      if ([200, 404, 413, 422].includes(sent?.status)) await motion.discard();
      if (sent?.status === 200) status(T('Se han subido los sensores que se habían quedado en el móvil.'), 'success');
    } catch {}
  })().finally(() => {resending = null;});
}

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
    closeMap();
    show();
    await uploadSensors(result.activity.id);
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
  approach = approachWatch(catalog);
  $('circuit').append(...catalog.map(c => node('option', {value: c.id, textContent: c.name})));
  $('circuit').addEventListener('change', () => {circuit = null; timer = null; if (lastFix) pickCircuit(lastFix); show();});
  shell.onUser(() => {show(); if (fixes.length && !stopWatch) status(T('Ya puedes guardar la grabación.'), 'success'); else resendSensors();});
  // A recording not saved (the page was closed or reloaded): it can be saved or recorded on.
  fixes = kept();
  if (fixes.length) status(T('Hay una grabación sin guardar de las {time} ({n} puntos): guárdala, sigue grabando o descártala.',
    {time: new Date(fixes[0].time).toLocaleTimeString(locale, {hour: '2-digit', minute: '2-digit'}), n: fixes.length}));
  show();
  resendSensors();
}
start().catch(err => status('Error: ' + err.message, 'error'));
