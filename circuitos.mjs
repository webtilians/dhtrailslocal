// DH Trails v0.8 — Circuitos (organization): import a route, mark start, finish and segments, save.
import {parseGps, nearestTrackIndex, buildCircuit, distanceSeries, summarize, detectAttempts, referenceStops, withoutStops} from './gps-engine.mjs';
import {formatMs} from './sector-comparison.mjs';
import {circuitChecks} from './circuit-checks.mjs';
import {$, node, say, startShell, createMap, pin, drawCircuit, km, dateText} from './app-shell.mjs';
import {T, dec} from './i18n.mjs';
import {asGpsFile} from './fit.mjs';

const view = createMap('map');
const blank = () => ({start: null, finish: null, gates: []});
let shell = null, source = null, tool = '', draft = blank(), history = [], saved = [];
// The saved circuit being changed (null: a new one); saved: the bar over the map keeps the last result.
let editing = null, savedNote = false;
const others = () => saved.filter(c => c.id !== editing?.id);
const status = (message, type = '') => say($('status'), message, type);
// What saving said, under the button that saved: in «3 Guardar ruta» and in the bar over the map.
const feedback = (message, type = '') => {say($('saveFeedback'), message, type); say($('mapBarMessage'), message, type);};
const latlon = p => [p.lat, p.lon];
const SNAP_M = 35;

function snapshot() {savedNote = false; history.push(JSON.stringify(draft)); if (history.length > 40) history.shift();}
// Over the map, where the line is being marked: the save button (the one in «3 Guardar ruta» falls
// below a long list of segments), what is being edited, and what saving said.
function drawBar() {
  const ready = !!source && draft.start !== null && draft.finish !== null;
  $('mapBar').hidden = !editing && !ready && !savedNote;
  $('mapBarText').hidden = !editing && !ready;
  $('mapBarText').textContent = !editing ? T('Salida y meta marcadas: ya se puede guardar.') : editing.published ?
    T('Editando «{name}» (se usa en un torneo): mueve la meta, la salida o los segmentos, o importa otra ruta, y guarda.', {name: editing.name}) :
    T('Editando «{name}»: mueve la meta, la salida o los segmentos, o importa otra ruta, y guarda.', {name: editing.name});
  $('saveNear').hidden = !ready;
  $('saveNear').textContent = editing ? T('Guardar los cambios') : T('Guardar ruta');
  $('stopEditing').hidden = !editing;
}
$('saveNear').addEventListener('click', () => {
  if ($('circuitName').value.trim()) return $('saveRoute').click();
  $('circuitName').scrollIntoView({behavior: 'smooth', block: 'center'});
  $('circuitName').focus({preventScroll: true});
  feedback(T('Escribe el nombre del circuito y vuelve a pulsar Guardar.'), 'error');
});
function setTool(next) {
  tool = next;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $('toolHint').textContent = {start: T('Haz clic en la salida'), finish: T('Haz clic en la meta'), gate: T('Haz clic donde acaba un segmento')}[tool] ||
    T('Elige Salida, Meta o Segmento');
}
function stats(points, segments) {
  if (!points?.length) {['statDistance', 'statSegments', 'statDescent'].forEach(id => $(id).textContent = '—'); return;}
  const meta = summarize(points);
  $('statDistance').textContent = km(meta.meters);
  $('statSegments').textContent = String(segments);
  $('statDescent').textContent = Math.round(meta.descent) + ' m';
}

function redraw() {
  view.clear();
  const list = $('gatesList');
  list.replaceChildren();
  if (!source) {stats(null); drawBar(); return;}
  const {start, finish, gates} = draft;
  // The imported route in white over a dark edge, to be seen on the map and on the satellite; the
  // circuit (start to finish) in magenta over it: neither the colour of a pin.
  const line = (points, color, weight) => {
    view.add(L.polyline(points, {color: '#06121e', weight: weight + 4, opacity: .85, interactive: false}));
    view.add(L.polyline(points, {color, weight, opacity: 1, interactive: false}));
  };
  line(source.map(latlon), '#ffffff', 4);
  if (start !== null && finish !== null) line(source.slice(start, finish + 1).map(latlon), '#ff3fd2', 5);
  if (start !== null) pin(view, latlon(source[start]), 'start', T('Salida · arrastra para ajustar'), at => move('start', 0, at));
  gates.forEach((g, i) => pin(view, latlon(source[g.index]), 'gate', T('Fin del segmento {n}', {n: i + 1}), at => move('gate', i, at)));
  if (finish !== null) pin(view, latlon(source[finish]), 'finish', T('Meta · arrastra para ajustar'), at => move('finish', 0, at));
  // Segment list: Salida → boundaries (renamable) → Meta.
  if (start === null) list.append(node('p', {className: 'placeholder', textContent: T('Marca la salida, la meta y, entre medias, dónde acaba cada segmento.')}));
  else {
    list.append(node('div', {className: 'item', textContent: T('Salida')}));
    gates.forEach((g, i) => {
      const name = node('input', {value: g.name, maxLength: 70, ariaLabel: T('Nombre del límite {n}', {n: i + 1})});
      name.addEventListener('change', () => {draft.gates[i].name = name.value.trim() || T('Segmento {n}', {n: i + 1});});
      const remove = node('button', {type: 'button', textContent: '✕', title: T('Quitar este límite')});
      remove.addEventListener('click', () => {snapshot(); draft.gates.splice(i, 1); redraw();});
      list.append(node('div', {className: 'item'}, [node('small', {textContent: T('Fin seg. {n}', {n: i + 1})}), name, remove]));
    });
    list.append(node('div', {className: 'item', textContent: finish === null ? T('Meta · pendiente') : T('Meta')}));
  }
  const ready = start !== null && finish !== null;
  stats(ready ? source.slice(start, finish + 1) : source, gates.length + 1);
  renderChecks(ready ? circuitChecks(source, start, finish, gates, others()) : []);
  $('mapTag').textContent = ready ? T('LISTA PARA GUARDAR') : T('MARCA SALIDA Y META');
  drawBar();
}

// What could make the circuit's timing unreliable, and other circuits on the same trail.
function renderChecks(checks) {
  $('checks').replaceChildren(...checks.map(c => node('p', {className: 'circuit-note ' + c.level, textContent: c.text})));
  $('checks').hidden = !checks.length;
}

// Clicks and drags land on the nearest GPS point of the imported route.
function place(index) {
  const {start, finish, gates} = draft;
  if (tool === 'start') {
    if (finish !== null && index >= finish - 15) return status(T('La salida debe quedar antes de la meta.'), 'error');
    if (gates.some(g => g.index <= index + 1)) return status(T('La salida debe quedar antes de los segmentos.'), 'error');
    snapshot(); draft.start = index;
  } else if (tool === 'finish') {
    if (start === null) return status(T('Marca primero la salida.'), 'error');
    if (index <= start + 15 || gates.some(g => g.index >= index - 1)) return status(T('La meta debe quedar después de la salida y de los segmentos.'), 'error');
    snapshot(); draft.finish = index;
  } else if (tool === 'gate') {
    if (start === null) return status(T('Marca primero la salida.'), 'error');
    if (index <= start + 1 || (finish !== null && index >= finish - 1) || gates.some(g => Math.abs(g.index - index) < 2))
      return status(T('El límite debe quedar entre la salida y la meta, sin repetir.'), 'error');
    snapshot();
    draft.gates.push({index, name: T('Segmento {n}', {n: gates.length + 1})});
    draft.gates.sort((a, b) => a.index - b.index);
  } else return status(T('Elige primero Salida, Meta o Segmento.'), 'error');
  status(T('Bien. Sigue marcando o guarda la ruta cuando estén la salida y la meta.'));
  redraw();
}
function move(kind, i, at) {
  const snap = nearestTrackIndex(source, at);
  if (snap.meters > SNAP_M) status(T('Acércate a la ruta: el marcador debe quedar a menos de 35 m de la línea.'), 'error');
  else if (kind === 'gate') {
    const {start, finish} = draft, others = draft.gates.filter((_, n) => n !== i);
    if (snap.index <= start + 1 || (finish !== null && snap.index >= finish - 1) || others.some(g => Math.abs(g.index - snap.index) < 2))
      status(T('El límite debe quedar entre la salida y la meta, sin repetir.'), 'error');
    else {snapshot(); draft.gates[i].index = snap.index; draft.gates.sort((x, y) => x.index - y.index);}
  } else {const previous = tool; tool = kind; place(snap.index); tool = previous;}
  redraw();
}
// While a tool is chosen, a dot shows on the route where a click would land.
const aim = L.circleMarker([0, 0], {radius: 8, weight: 3, color: '#ffffff', fillOpacity: 1, interactive: false});
const AIM_COLORS = {start: '#1fd68c', finish: '#f85d74', gate: '#f2c34f'};
let aimFrame = 0;
view.map.on('mousemove', event => {
  cancelAnimationFrame(aimFrame);
  aimFrame = requestAnimationFrame(() => {
    const near = source && tool ? nearestTrackIndex(source, event.latlng) : null;
    if (!near || near.meters > SNAP_M) {aim.remove(); view.map.getContainer().style.cursor = ''; return;}
    aim.setLatLng(latlon(source[near.index])).setStyle({fillColor: AIM_COLORS[tool]});
    if (!view.map.hasLayer(aim)) aim.addTo(view.map);
    view.map.getContainer().style.cursor = 'crosshair';
  });
});
view.map.on('mouseout', () => {cancelAnimationFrame(aimFrame); aim.remove();});
view.map.on('click', event => {
  if (!source) return;
  const nearest = nearestTrackIndex(source, event.latlng);
  if (nearest.meters > SNAP_M) return status(T('Haz clic más cerca de la línea de la ruta (35 m como mucho).'), 'error');
  place(nearest.index);
});
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
  if (!source) return status(T('Importa primero un archivo.'), 'error');
  setTool(b.dataset.tool);
}));
$('undo').addEventListener('click', () => {
  if (!history.length) return status(T('No hay nada que deshacer.'));
  draft = JSON.parse(history.pop()); redraw(); status(T('Último cambio deshecho.'));
});

// A GPX/TCX starts from scratch; a circuit file (.json) comes with its start, segments and finish.
// The route: a file of the device, or one of the rider's saved routes (a ride recorded with Grabar or
// uploaded to Entrenamiento), which the server keeps.
$('routeFile').addEventListener('change', async e => {
  await importFile(e.target.files[0]);
  e.target.value = '';
});
async function importFile(file) {
  if (!file) return;
  savedNote = false;
  try {
    file = await asGpsFile(file);
    if (file.size > 20 * 1024 * 1024) throw Error(T('El archivo supera los 20 MB.'));
    const ext = file.name.split('.').at(-1).toLowerCase();
    if (ext === 'json') {
      const c = JSON.parse(await file.text());
      if (!Array.isArray(c?.points) || c.points.length < 16 || !Array.isArray(c.sectors)) throw Error(T('El archivo no es un circuito de DH Trails.'));
      source = c.points.map(p => ({lat: p[0], lon: p[1], ele: p[2] ?? null, time: null}));
      draft = {start: 0, finish: source.length - 1, gates: c.sectors.map((s, i) => ({index: s.index, name: s.name || T('Segmento {n}', {n: i + 1})}))};
      $('circuitName').value = c.name || '';
    } else if (ext === 'gpx' || ext === 'tcx') {
      source = parseGps(await file.text(), ext);
      draft = blank();
      setTool('start');
    } else throw Error(T('Usa un archivo GPX, TCX, FIT o un circuito .json.'));
    history = [];
    $('sourceName').textContent = file.name + ' · ' + T('{n} puntos', {n: source.length});
    redraw();
    view.fit(source.map(latlon), 25);
    status(ext === 'json' ? T('Circuito cargado: revisa los puntos y pulsa Guardar ruta.') : T('Ruta cargada. Marca la salida sobre la línea.'), 'success');
  } catch (err) {status(err.message, 'error');}
}
async function useSavedRoute(id) {
  const route = savedRoutes.find(r => r.id === id);
  if (!route) return;
  status(T('Cargando {file}…', {file: route.filename}));
  try {await importFile(new File([await shell.api.activityFile(id)], route.filename));}
  catch (err) {status(err.message, 'error');}
}
let savedRoutes = [];
async function loadSavedRoutes() {
  savedRoutes = await shell.api.trainingRoutes();
  $('savedRoutes').hidden = !savedRoutes.length;
  $('savedRoute').replaceChildren(...savedRoutes.map(r => node('option', {value: r.id, textContent: r.filename + ' · ' +
    dateText(r.recorded_at || r.created_at) + (r.distance_m ? ' · ' + km(r.distance_m) : '')})));
}
$('useRoute').addEventListener('click', () => useSavedRoute($('savedRoute').value));

// A watch keeps recording during a stop: the stop is cut out of the line, and a clean run of the
// same file is offered first when there is one.
function cleanReference() {
  const stopped = referenceStops(source, draft.start, draft.finish);
  if (stopped < 30) return true;
  const sectors = draft.gates.map(g => ({index: g.index, name: g.name}));
  let clean = null;
  try {
    const c = withoutStops(source, draft.start, draft.finish, sectors, []);
    const provisional = buildCircuit($('circuitName').value || 'Provisional', c.route, c.start, c.finish, c.sectors, c.zones);
    clean = detectAttempts(source, provisional)
      .filter(a => (a.finishIndex < draft.start || a.startIndex > draft.finish) && a.status === 'compatible' &&
        a.gateIndices.every(Number.isInteger) && referenceStops(source, a.startIndex, a.finishIndex) < 30)
      .sort((a, b) => a.seconds - b.seconds)[0] || null;
  } catch {}
  if (!clean || !window.confirm(T('La bajada marcada incluye una parada de {min} min (el GPS sigue grabando parado).\n\nEn este mismo archivo hay ' +
      'otra bajada sin paradas ({time}). ¿Usarla, con los mismos segmentos?\n\nSi cancelas, se guarda la marcada quitando la parada.',
      {min: dec(stopped / 60), time: formatMs(clean.seconds * 1000)}))) return true;
  snapshot();
  draft = {start: clean.startIndex, finish: clean.finishIndex,
    gates: clean.gateIndices.slice(1, -1).map((index, i) => ({index, name: draft.gates[i].name}))};
  redraw();
  view.fit(source.slice(draft.start, draft.finish + 1).map(latlon), 25);
  feedback(T('Ahora está marcada la bajada sin paradas. Revisa los puntos y pulsa Guardar ruta otra vez.'), 'success');
  return false;
}
$('saveRoute').addEventListener('click', async () => {
  try {
    if (!shell?.me) throw Error(T('Entra con tu cuenta.'));
    if (!source) throw Error(T('Importa primero un archivo.'));
    if (draft.start === null || draft.finish === null) throw Error(T('Marca la salida y la meta.'));
    if (!$('circuitName').value.trim()) throw Error(T('Escribe el nombre del circuito.'));
    const warnings = circuitChecks(source, draft.start, draft.finish, draft.gates, others()).filter(c => c.level === 'warning');
    // A rider may not repeat a circuit that exists (the server says so too); an organizer is warned.
    const repeat = warnings.find(w => w.same);
    if (repeat && !shell.me.organizer) throw Error(repeat.text + ' ' + T('Búscalo en la lista de circuitos.'));
    if (warnings.length && !window.confirm(T('Antes de guardar, revisa:') + '\n\n• ' + warnings.map(w => w.text).join('\n• ') +
      '\n\n' + T('¿Guardar el circuito así?'))) return feedback(T('No se ha guardado: corrige la salida, la meta o los segmentos y vuelve a guardar.'));
    if (!cleanReference()) return;
    const c = withoutStops(source, draft.start, draft.finish, draft.gates.map(g => ({index: g.index, name: g.name})), []);
    const circuit = buildCircuit($('circuitName').value, c.route, c.start, c.finish, c.sectors, c.zones);
    const changed = editing;
    if (changed) {
      circuit.cloud_id = changed.id;
      // A circuit a tournament uses: its entries are timed again, and its standings change.
      if (changed.published && !window.confirm(T('«{name}» se usa en un torneo. Al guardarlo se vuelven a cronometrar {entries} con la salida, la meta y ' +
          'los segmentos nuevos (cambia su clasificación) y se buscan otra vez las de entrenamiento.\n\n¿Guardar los cambios?', {name: changed.name,
            entries: changed.entries === 1 ? T('su bajada de torneo') : T('sus {n} bajadas de torneo', {n: changed.entries})})))
        return feedback(T('No se ha guardado.'));
    }
    $('saveRoute').disabled = true;
    await shell.api.saveCircuit(circuit);
    const said = changed ? [T('Circuito «{name}» actualizado.', {name: circuit.name}),
        changed.published ? T('Se están volviendo a cronometrar sus bajadas de torneo y buscando otra vez las de entrenamiento: en unos segundos verás ' +
          'los tiempos nuevos en Time trial, Entrenamiento y Récords.') : T('Se están buscando otra vez sus bajadas en todas las rutas de entrenamiento.'),
        !changed.published && !shell.me.organizer ? T('La organización lo revisará de nuevo para poder usarlo en torneos.') : ''] :
      [T('Circuito «{name}» guardado.', {name: circuit.name}),
        c.seconds >= 30 ? T('Se ha quitado del trazado una parada de {min} min.', {min: dec(c.seconds / 60)}) : '',
        shell.me.organizer ? T('Ya puedes usarlo en un torneo.') : T('Ya cuenta para los entrenamientos de todos; la organización lo revisará para poder usarlo en torneos.'),
        T('Además se está buscando en todas las rutas de entrenamiento ya subidas: sus bajadas aparecerán en Entrenamiento.')];
    feedback(said.filter(Boolean).join(' '), 'success');
    setEditing(null);
    savedNote = true;
    source = null; draft = blank(); history = []; setTool(''); renderChecks([]);
    $('circuitName').value = ''; $('sourceName').textContent = T('La ruta de una bajada que pase por todo el circuito');
    await loadSaved();
    show(saved.find(x => x.name === circuit.name) || saved[0]);
  } catch (err) {feedback(T('No se ha guardado: {error}', {error: err.message}), 'error');}
  finally {$('saveRoute').disabled = false;}
});

// Change a saved circuit: its line comes into the editor with its start, segments and finish, to move
// them (a finish too far, a segment in the wrong place) or to import another route for it.
function setEditing(c) {
  editing = c;
  $('saveRoute').textContent = c ? T('Guardar los cambios') : T('Guardar ruta');
  drawBar();
}
function startEditing(c) {
  savedNote = false;
  feedback('');
  setEditing(c);
  source = c.points.map(p => ({lat: p[0], lon: p[1], ele: p[2] ?? null, time: null}));
  draft = {start: 0, finish: source.length - 1, gates: c.sectors.map((s, i) => ({index: s.index, name: s.name || T('Segmento {n}', {n: i + 1})}))};
  history = [];
  $('circuitName').value = c.name;
  $('sourceName').textContent = T('El trazado guardado de {name}', {name: c.name}) + ' · ' + T('{n} puntos', {n: source.length});
  setTool('finish');
  redraw();
  view.fit(source.map(latlon), 25);
  // The bar with the save button first, then the map (on a phone, «3 Guardar ruta» is far above).
  $('mapBar').scrollIntoView({behavior: 'smooth', block: 'start'});
  status(T('Editando «{name}». Arrastra la meta (o la salida, o un límite) a su sitio, o elige una herramienta y haz clic en la línea.', {name: c.name}), 'success');
}
$('stopEditing').addEventListener('click', () => {
  savedNote = false;
  setEditing(null);
  source = null; draft = blank(); history = []; setTool(''); renderChecks([]); redraw();
  $('circuitName').value = ''; $('sourceName').textContent = T('La ruta de una bajada que pase por todo el circuito');
  feedback('');
});

function show(c) {
  if (!c) return;
  source = null; redraw();
  drawCircuit(view, c, {color: '#ff3fd2'});
  $('mapTag').textContent = c.name.toUpperCase();
  stats(c.points.map(p => ({lat: p[0], lon: p[1], ele: p[2] ?? null})), c.sectors.length + 1);
}
async function loadSaved() {
  saved = await shell.api.listCircuits();
  $('savedCount').textContent = saved.length ? T('{n} EN TOTAL', {n: saved.length}) : '';
  $('savedList').replaceChildren(...(saved.length ? saved.map(c => {
    const see = node('button', {type: 'button', className: 'btn outline small', textContent: T('Ver')});
    see.addEventListener('click', () => show(c));
    // Who drew it, and whether the organization accepted it for tournaments.
    const badge = c.published ? node('span', {className: 'badge ok', textContent: T('En torneo')}) :
      c.approved ? node('span', {className: 'badge ok', textContent: T('Aprobado')}) : node('span', {className: 'badge', textContent: T('Pendiente')});
    const row = node('div', {className: 'item'}, [
      node('span', {}, [node('b', {textContent: c.name}), node('small', {textContent: ' · ' + km(distanceSeries(c.points).at(-1)) + ' · ' +
        T('{n} segmentos', {n: c.sectors.length + 1}) + ' · ' + (c.mine ? T('tuyo') : T('de {name}', {name: c.owner || T('otro piloto')}))})]),
      node('span', {className: 'row-actions'}, [badge, see])]);
    if (shell.me?.organizer && !c.approved) {
      const approve = node('button', {type: 'button', className: 'btn primary small', textContent: T('Aprobar')});
      approve.addEventListener('click', async () => {
        try {await shell.api.approveCircuit(c.id); await loadSaved(); status(T('«{name}» aprobado: ya se puede usar en un torneo.', {name: c.name}), 'success');}
        catch (err) {status(T('No se pudo aprobar: {error}', {error: err.message}), 'error');}
      });
      row.lastChild.append(approve);
    }
    if (c.can_edit) {
      const change = node('button', {type: 'button', className: 'btn outline small', textContent: T('Editar')});
      change.addEventListener('click', () => startEditing(c));
      row.lastChild.append(change);
    }
    if (c.can_delete) {
      const remove = node('button', {type: 'button', className: 'text-btn danger', textContent: T('Borrar')});
      remove.addEventListener('click', async () => {
        if (!window.confirm(T('¿Borrar el circuito «{name}»? Las bajadas de entrenamiento encontradas en él también se borran.', {name: c.name}))) return;
        try {await shell.api.deleteCircuit(c.id); await loadSaved(); view.clear(); stats(null); status(T('Circuito borrado.'), 'success');}
        catch (err) {status(T('No se pudo borrar: {error}', {error: err.message}), 'error');}
      });
      row.lastChild.append(remove);
    }
    return row;
  }) : [node('p', {className: 'placeholder', textContent: T('Todavía no hay circuitos guardados.')})]));
}

async function start() {
  shell = await startShell('circuitos');
  const allowed = () => {
    const ok = !!shell.me;
    $('workspace').hidden = !ok;
    $('notAllowed').hidden = ok;
    if (!ok && shell.api && !shell.me) shell.askLogin(T('Entra con tu cuenta para crear los circuitos de tu zona.'));
    return ok;
  };
  shell.onUser(() => {if (allowed()) Promise.all([loadSaved(), loadSavedRoutes()]).catch(err => status(err.message, 'error'));});
  if (!shell.api) {$('workspace').hidden = true; $('notAllowed').hidden = false; $('notAllowed').textContent = T('Esta página necesita el servidor de DH Trails.'); return;}
  if (allowed()) {
    await Promise.all([loadSaved(), loadSavedRoutes()]);
    view.map.invalidateSize();
    // Sent here from Grabar with the ride just saved (?ruta=its id).
    const asked = new URLSearchParams(location.search).get('ruta');
    if (asked) {window.history.replaceState(null, '', location.pathname); await useSavedRoute(asked);}
  }
}
start().catch(err => status('Error: ' + err.message, 'error'));
