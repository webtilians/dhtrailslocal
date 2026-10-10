// DH Trails v0.8 — Circuitos (organization): import a route, mark start, finish and segments, save.
import {parseGps, nearestTrackIndex, buildCircuit, distanceSeries, summarize, detectAttempts, referenceStops, withoutStops} from './gps-engine.mjs';
import {formatMs} from './sector-comparison.mjs';
import {$, node, say, startShell, createMap, pin, drawCircuit, km} from './app-shell.mjs';

const view = createMap('map');
const blank = () => ({start: null, finish: null, gates: []});
let shell = null, source = null, tool = '', draft = blank(), history = [], saved = [];
const status = (message, type = '') => say($('status'), message, type);
const feedback = (message, type = '') => say($('saveFeedback'), message, type);
const latlon = p => [p.lat, p.lon];
const SNAP_M = 35;

function snapshot() {history.push(JSON.stringify(draft)); if (history.length > 40) history.shift();}
function setTool(next) {
  tool = next;
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
  $('toolHint').textContent = {start: 'Haz clic en la salida', finish: 'Haz clic en la meta', gate: 'Haz clic donde acaba un segmento'}[tool] || 'Elige Salida, Meta o Segmento';
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
  if (!source) {stats(null); return;}
  const {start, finish, gates} = draft;
  view.add(L.polyline(source.map(latlon), {color: '#427695', weight: 3, opacity: .6}));
  if (start !== null && finish !== null) view.add(L.polyline(source.slice(start, finish + 1).map(latlon), {color: '#1aa5ff', weight: 6}));
  if (start !== null) pin(view, latlon(source[start]), 'start', 'Salida · arrastra para ajustar', at => move('start', 0, at));
  gates.forEach((g, i) => pin(view, latlon(source[g.index]), 'gate', 'Fin del segmento ' + (i + 1), at => move('gate', i, at)));
  if (finish !== null) pin(view, latlon(source[finish]), 'finish', 'Meta · arrastra para ajustar', at => move('finish', 0, at));
  // Segment list: Salida → boundaries (renamable) → Meta.
  if (start === null) list.append(node('p', {className: 'placeholder', textContent: 'Marca la salida, la meta y, entre medias, dónde acaba cada segmento.'}));
  else {
    list.append(node('div', {className: 'item', textContent: 'Salida'}));
    gates.forEach((g, i) => {
      const name = node('input', {value: g.name, maxLength: 70, ariaLabel: 'Nombre del límite ' + (i + 1)});
      name.addEventListener('change', () => {draft.gates[i].name = name.value.trim() || 'Segmento ' + (i + 1);});
      const remove = node('button', {type: 'button', textContent: '✕', title: 'Quitar este límite'});
      remove.addEventListener('click', () => {snapshot(); draft.gates.splice(i, 1); redraw();});
      list.append(node('div', {className: 'item'}, [node('small', {textContent: 'Fin seg. ' + (i + 1)}), name, remove]));
    });
    list.append(node('div', {className: 'item', textContent: finish === null ? 'Meta · pendiente' : 'Meta'}));
  }
  const ready = start !== null && finish !== null;
  stats(ready ? source.slice(start, finish + 1) : source, gates.length + 1);
  $('mapTag').textContent = ready ? 'LISTA PARA GUARDAR' : 'MARCA SALIDA Y META';
}

// Clicks and drags land on the nearest GPS point of the imported route.
function place(index) {
  const {start, finish, gates} = draft;
  if (tool === 'start') {
    if (finish !== null && index >= finish - 15) return status('La salida debe quedar antes de la meta.', 'error');
    if (gates.some(g => g.index <= index + 1)) return status('La salida debe quedar antes de los segmentos.', 'error');
    snapshot(); draft.start = index;
  } else if (tool === 'finish') {
    if (start === null) return status('Marca primero la salida.', 'error');
    if (index <= start + 15 || gates.some(g => g.index >= index - 1)) return status('La meta debe quedar después de la salida y de los segmentos.', 'error');
    snapshot(); draft.finish = index;
  } else if (tool === 'gate') {
    if (start === null) return status('Marca primero la salida.', 'error');
    if (index <= start + 1 || (finish !== null && index >= finish - 1) || gates.some(g => Math.abs(g.index - index) < 2))
      return status('El límite debe quedar entre la salida y la meta, sin repetir.', 'error');
    snapshot();
    draft.gates.push({index, name: 'Segmento ' + (gates.length + 1)});
    draft.gates.sort((a, b) => a.index - b.index);
  } else return status('Elige primero Salida, Meta o Segmento.', 'error');
  status('Bien. Sigue marcando o guarda la ruta cuando estén la salida y la meta.');
  redraw();
}
function move(kind, i, at) {
  const snap = nearestTrackIndex(source, at);
  if (snap.meters > SNAP_M) status('Acércate a la ruta: el marcador debe quedar a menos de 35 m de la línea.', 'error');
  else if (kind === 'gate') {
    const {start, finish} = draft, others = draft.gates.filter((_, n) => n !== i);
    if (snap.index <= start + 1 || (finish !== null && snap.index >= finish - 1) || others.some(g => Math.abs(g.index - snap.index) < 2))
      status('El límite debe quedar entre la salida y la meta, sin repetir.', 'error');
    else {snapshot(); draft.gates[i].index = snap.index; draft.gates.sort((x, y) => x.index - y.index);}
  } else {const previous = tool; tool = kind; place(snap.index); tool = previous;}
  redraw();
}
view.map.on('click', event => {
  if (!source) return;
  const nearest = nearestTrackIndex(source, event.latlng);
  if (nearest.meters > SNAP_M) return status('Haz clic más cerca de la línea de la ruta (35 m como mucho).', 'error');
  place(nearest.index);
});
document.querySelectorAll('[data-tool]').forEach(b => b.addEventListener('click', () => {
  if (!source) return status('Importa primero un archivo.', 'error');
  setTool(b.dataset.tool);
}));
$('undo').addEventListener('click', () => {
  if (!history.length) return status('No hay nada que deshacer.');
  draft = JSON.parse(history.pop()); redraw(); status('Último cambio deshecho.');
});

// A GPX/TCX starts from scratch; a circuit file (.json) comes with its start, segments and finish.
$('routeFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw Error('El archivo supera los 20 MB.');
    const ext = file.name.split('.').at(-1).toLowerCase();
    if (ext === 'json') {
      const c = JSON.parse(await file.text());
      if (!Array.isArray(c?.points) || c.points.length < 16 || !Array.isArray(c.sectors)) throw Error('El archivo no es un circuito de DH Trails.');
      source = c.points.map(p => ({lat: p[0], lon: p[1], ele: p[2] ?? null, time: null}));
      draft = {start: 0, finish: source.length - 1, gates: c.sectors.map((s, i) => ({index: s.index, name: s.name || 'Segmento ' + (i + 1)}))};
      $('circuitName').value = c.name || '';
    } else if (ext === 'gpx' || ext === 'tcx') {
      source = parseGps(await file.text(), ext);
      draft = blank();
      setTool('start');
    } else throw Error('Usa un archivo GPX, TCX o un circuito .json.');
    history = [];
    $('sourceName').textContent = file.name + ' · ' + source.length + ' puntos';
    redraw();
    view.fit(source.map(latlon), 25);
    status(ext === 'json' ? 'Circuito cargado: revisa los puntos y pulsa Guardar ruta.' : 'Ruta cargada. Marca la salida sobre la línea.', 'success');
  } catch (err) {status(err.message, 'error');}
  e.target.value = '';
});

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
  if (!clean || !window.confirm('La bajada marcada incluye una parada de ' + (stopped / 60).toFixed(1).replace('.', ',') +
      ' min (el GPS sigue grabando parado).\n\nEn este mismo archivo hay otra bajada sin paradas (' + formatMs(clean.seconds * 1000) +
      '). ¿Usarla, con los mismos segmentos?\n\nSi cancelas, se guarda la marcada quitando la parada.')) return true;
  snapshot();
  draft = {start: clean.startIndex, finish: clean.finishIndex,
    gates: clean.gateIndices.slice(1, -1).map((index, i) => ({index, name: draft.gates[i].name}))};
  redraw();
  view.fit(source.slice(draft.start, draft.finish + 1).map(latlon), 25);
  feedback('Ahora está marcada la bajada sin paradas. Revisa los puntos y pulsa Guardar ruta otra vez.', 'success');
  return false;
}
$('saveRoute').addEventListener('click', async () => {
  try {
    if (!shell?.me?.organizer) throw Error('Entra con tu cuenta de organizador.');
    if (!source) throw Error('Importa primero un archivo.');
    if (draft.start === null || draft.finish === null) throw Error('Marca la salida y la meta.');
    if (!$('circuitName').value.trim()) throw Error('Escribe el nombre del circuito.');
    if (!cleanReference()) return;
    const c = withoutStops(source, draft.start, draft.finish, draft.gates.map(g => ({index: g.index, name: g.name})), []);
    const circuit = buildCircuit($('circuitName').value, c.route, c.start, c.finish, c.sectors, c.zones);
    $('saveRoute').disabled = true;
    await shell.api.saveCircuit(circuit);
    feedback('Ruta «' + circuit.name + '» guardada.' + (c.seconds >= 30 ? ' Se ha quitado del trazado una parada de ' +
      (c.seconds / 60).toFixed(1).replace('.', ',') + ' min.' : '') + ' Ya puedes usarla en un torneo.', 'success');
    source = null; draft = blank(); history = []; setTool('');
    $('circuitName').value = ''; $('sourceName').textContent = 'La ruta de una bajada que pase por todo el circuito';
    await loadSaved();
    show(saved.find(x => x.name === circuit.name) || saved[0]);
  } catch (err) {feedback('No se ha guardado: ' + err.message, 'error');}
  finally {$('saveRoute').disabled = false;}
});

function show(c) {
  if (!c) return;
  source = null; redraw();
  drawCircuit(view, c);
  $('mapTag').textContent = c.name.toUpperCase();
  stats(c.points.map(p => ({lat: p[0], lon: p[1], ele: p[2] ?? null})), c.sectors.length + 1);
}
async function loadSaved() {
  saved = await shell.api.listCircuits();
  $('savedCount').textContent = saved.length ? saved.length + ' EN TOTAL' : '';
  $('savedList').replaceChildren(...(saved.length ? saved.map(c => {
    const see = node('button', {type: 'button', className: 'btn outline small', textContent: 'Ver'});
    see.addEventListener('click', () => show(c));
    const row = node('div', {className: 'item'}, [
      node('span', {}, [node('b', {textContent: c.name}), node('small', {textContent: ' · ' + km(distanceSeries(c.points).at(-1)) + ' · ' + (c.sectors.length + 1) + ' segmentos'})]),
      node('span', {className: 'row-actions'}, [
        ...(c.published ? [node('span', {className: 'badge ok', textContent: 'En torneo'})] : []), see])]);
    if (!c.published) {
      const remove = node('button', {type: 'button', className: 'text-btn danger', textContent: 'Borrar'});
      remove.addEventListener('click', async () => {
        if (!window.confirm('¿Borrar el circuito «' + c.name + '»? Las bajadas de entrenamiento encontradas en él también se borran.')) return;
        try {await shell.api.deleteCircuit(c.id); await loadSaved(); view.clear(); stats(null); status('Circuito borrado.', 'success');}
        catch (err) {status('No se pudo borrar: ' + err.message, 'error');}
      });
      row.lastChild.append(remove);
    }
    return row;
  }) : [node('p', {className: 'placeholder', textContent: 'Todavía no hay circuitos guardados.'})]));
}

async function start() {
  shell = await startShell('circuitos');
  const allowed = () => {
    const ok = !!shell.me?.organizer;
    $('workspace').hidden = !ok;
    $('notAllowed').hidden = ok;
    if (!ok && shell.api && !shell.me) shell.askLogin('Entra con tu cuenta de organizador para crear circuitos.');
    return ok;
  };
  shell.onUser(() => {if (allowed()) loadSaved().catch(err => status(err.message, 'error'));});
  if (!shell.api) {$('workspace').hidden = true; $('notAllowed').hidden = false; $('notAllowed').textContent = 'Esta página necesita el servidor de DH Trails.'; return;}
  if (allowed()) {await loadSaved(); view.map.invalidateSize();}
}
start().catch(err => status('Error: ' + err.message, 'error'));
