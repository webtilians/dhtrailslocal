// DH Trails v0.8 — Entrenamiento: upload routes, find the app's circuits in them, overlay runs.
import {formatMs, formatDelta} from './sector-comparison.mjs';
import {resample, speedSeries, gapSeries, segmentTimes, circuitPosition} from './telemetry.mjs';
import {lineChart} from './charts.mjs';
import {distanceSeries} from './gps-engine.mjs';
import {$, node, say, startShell, createMap, km, dateText} from './app-shell.mjs';

// Categorical slots validated for the dark panel surface (CVD-safe in this order, max 4 runs).
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const view = createMap('map');
let shell = null, catalog = [], runs = [], picked = [];
const profiles = new Map();
const status = (message, type = '') => say($('status'), message, type);
// Day and hour tell apart several runs of the same outing.
const when = iso => iso ? new Date(iso).toLocaleString('es-ES', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '—';
const runLabel = r => when(r.started_at) + ' · ' + formatMs(r.elapsed_ms);
const circuitOf = id => catalog.find(c => c.id === id);
const HIGHLIGHT = '#ffe066';
let mapSelection = null, selectionLayer = null, charts = [], comparisonVersion = 0;

function showSelection(circuit, {reveal = false} = {}) {
  if (selectionLayer) view.map.removeLayer(selectionLayer);
  selectionLayer = null;
  charts.forEach(chart => chart?.setSelection(mapSelection?.kind === 'point' ? mapSelection.metres / 1000 : null));
  document.querySelectorAll('#segments [data-segment]').forEach(button => {
    const active = mapSelection?.kind === 'segment' && Number(button.dataset.segment) === mapSelection.index;
    button.setAttribute('aria-pressed', String(active));
    button.closest('td, th').classList.toggle('segment-selected', active);
  });
  $('clearMapSelection').hidden = !mapSelection;
  if (!mapSelection) {
    $('mapSelection').textContent = 'Pulsa una gráfica para localizar un punto o un sector de la tabla para resaltar su tramo.';
    return;
  }
  const distances = distanceSeries(circuit.points);
  if (mapSelection.kind === 'point') {
    const point = circuitPosition(circuit.points, distances, mapSelection.metres);
    const label = Math.round(Math.min(distances.at(-1), mapSelection.metres)) + ' m desde la salida';
    selectionLayer = L.circleMarker(point, {radius: 9, color: '#071423', weight: 3, fillColor: HIGHLIGHT, fillOpacity: 1})
      .addTo(view.map).bindTooltip(label, {permanent: true, direction: 'top', offset: [0, -10]});
    $('mapSelection').textContent = 'Punto seleccionado · ' + label;
    if (reveal) view.map.panTo(point);
  } else {
    const bounds = [0, ...circuit.sectors.map(s => s.index), circuit.points.length - 1];
    const start = bounds[mapSelection.index], end = bounds[mapSelection.index + 1];
    const points = circuit.points.slice(start, end + 1).map(p => p.slice(0, 2));
    selectionLayer = L.layerGroup([
      L.polyline(points, {color: '#071423', weight: 12, opacity: 1}),
      L.polyline(points, {color: HIGHLIGHT, weight: 7, opacity: 1}),
    ]).addTo(view.map);
    $('mapSelection').textContent = 'Sector S' + (mapSelection.index + 1) + ' resaltado · ' + Math.round(distances[start]) + '–' + Math.round(distances[end]) + ' m desde la salida';
    if (reveal) view.fit(points, 45);
  }
  if (reveal) $('map').scrollIntoView({behavior: 'smooth', block: 'center'});
}

function selectPoint(circuit, kilometres, {reveal = true} = {}) {
  mapSelection = {kind: 'point', circuitId: circuit.id, metres: kilometres * 1000};
  showSelection(circuit, {reveal});
}

async function loadRuns(keepCircuit) {
  runs = await shell.api.trainingRuns();
  const counts = new Map();
  for (const r of runs) counts.set(r.circuit_id, (counts.get(r.circuit_id) || 0) + 1);
  const select = $('circuitSelect');
  const previous = keepCircuit || select.value;
  select.replaceChildren(...(counts.size ? [...counts].map(([id, n]) => node('option', {value: id,
    textContent: (circuitOf(id)?.name || runs.find(r => r.circuit_id === id).circuit_name) + ' · ' + n + ' bajada(s)'})) :
    [node('option', {value: '', textContent: 'Sin bajadas todavía: sube una ruta'})]));
  if (counts.has(previous)) select.value = previous;
  pickDefault();
}

// By default compare the fastest run with the latest one (or the next latest if they are the same).
function pickDefault() {
  const mine = runs.filter(r => r.circuit_id === $('circuitSelect').value);
  const fastest = [...mine].sort((a, b) => a.elapsed_ms - b.elapsed_ms)[0];
  picked = [...new Set([fastest, ...mine].filter(Boolean).map(r => r.id))].slice(0, 2);
  renderRunList();
  compare().catch(err => status(err.message, 'error'));
}
function renderRunList() {
  const mine = runs.filter(r => r.circuit_id === $('circuitSelect').value);
  $('runList').replaceChildren(...mine.map(r => {
    const slot = picked.indexOf(r.id);
    const box = node('input', {type: 'checkbox', checked: slot >= 0});
    box.addEventListener('change', () => {
      if (box.checked && picked.length >= COLORS.length) {box.checked = false; return status('Puedes comparar hasta 4 bajadas a la vez.', 'error');}
      picked = box.checked ? [...picked, r.id] : picked.filter(id => id !== r.id);
      renderRunList();
      compare().catch(err => status(err.message, 'error'));
    });
    const chip = node('i', {className: 'chip'});
    if (slot >= 0) chip.style.background = COLORS[slot];
    return node('label', {className: 'run-option' + (slot >= 0 ? ' on' : '')}, [box, chip,
      node('span', {textContent: runLabel(r)}), node('small', {textContent: r.tournament_name ? 'Torneo · ' + r.tournament_name : r.source_filename || ''})]);
  }));
}

async function profileOf(id) {
  if (!profiles.has(id)) profiles.set(id, (await shell.api.trainingRun(id)).profile);
  return profiles.get(id);
}

async function compare() {
  const version = ++comparisonVersion;
  const circuit = circuitOf($('circuitSelect').value);
  if (mapSelection?.circuitId !== circuit?.id) mapSelection = null;
  charts = [];
  if (selectionLayer) view.map.removeLayer(selectionLayer);
  selectionLayer = null;
  view.clear();
  ['legend', 'speedChart', 'gapChart', 'segments'].forEach(id => $(id).replaceChildren());
  showSelection(circuit);
  if (!circuit) {$('compareTag').textContent = '—'; return;}
  $('compareTag').textContent = circuit.name.toUpperCase();
  const pts = circuit.points.map(p => [p[0], p[1]]);
  view.add(L.polyline(pts, {color: '#5d7c99', weight: 8, opacity: .45}));
  view.fit(pts);
  const chosen = picked.map(id => runs.find(r => r.id === id)).filter(Boolean);
  if (!chosen.length) {$('segments').replaceChildren(node('p', {className: 'placeholder', textContent: 'Elige bajadas para compararlas.'})); return;}
  const data = await Promise.all(chosen.map(async (r, i) => {
    const profile = await profileOf(r.id);
    return {run: r, color: COLORS[i], label: runLabel(r), profile, samples: resample(profile, 10)};
  }));
  if (version !== comparisonVersion) return;
  // Each run's own GPS line, in its colour.
  for (const d of data) view.add(L.polyline(d.profile.map(p => [p[2], p[3]]), {color: d.color, weight: 3, opacity: .95}))
    .bindTooltip(d.label, {sticky: true});
  const reference = data.reduce((a, b) => b.run.elapsed_ms < a.run.elapsed_ms ? b : a);
  $('legend').replaceChildren(...data.map(d => node('span', {className: 'legend-item'}, [
    Object.assign(node('i', {className: 'chip'}), {style: 'background:' + d.color}),
    node('span', {textContent: d.label + (d === reference ? ' · referencia' : '')})])));
  charts.push(lineChart($('speedChart'), {series: data.map(d => ({label: d.label, color: d.color,
    points: speedSeries(d.samples).map(p => ({x: p.s / 1000, y: p.kmh === null ? null : Math.round(p.kmh * 10) / 10}))})),
    yFormat: v => Math.round(v) + ' km/h', onSelect: (x, options) => selectPoint(circuit, x, options)}));
  charts.push(lineChart($('gapChart'), {series: data.map(d => ({label: d.label, color: d.color,
    points: gapSeries(d.samples, reference.samples).map(p => ({x: p.s / 1000, y: p.ms / 1000}))})),
    yFormat: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' s', zero: true,
    onSelect: (x, options) => selectPoint(circuit, x, options)}));
  renderSegments(circuit, data, reference);
  showSelection(circuit);
  const gates = gatesOf(circuit), referenceTimes = segmentTimes(reference.profile, gates);
  const worst = data.filter(d => d !== reference).map(d => {
    const lost = segmentTimes(d.profile, gates).map((t, i) => t - referenceTimes[i]);
    const i = lost.indexOf(Math.max(...lost));
    return d.label + ' pierde más en el segmento ' + (i + 1) + ' (' + formatDelta(lost[i]) + ')';
  });
  status(worst.length ? worst.join(' · ') + '.' : 'Elige otra bajada para compararla con esta.', 'success');
}
function gatesOf(circuit) {
  const d = distanceSeries(circuit.points);
  return circuit.sectors.map(s => d[s.index]);
}
function renderSegments(circuit, data, reference) {
  const times = data.map(d => segmentTimes(d.profile, gatesOf(circuit)));
  const best = times[0].map((_, i) => Math.min(...times.map(t => t[i])));
  const sectorButton = (text, i) => {
    const button = node('button', {type: 'button', className: 'segment-button', textContent: text,
      title: 'Ver sector S' + (i + 1) + ' en el mapa'});
    button.dataset.segment = i;
    button.setAttribute('aria-label', 'Ver sector S' + (i + 1) + ' en el mapa: ' + text);
    button.addEventListener('click', () => {
      mapSelection = {kind: 'segment', circuitId: circuit.id, index: i};
      showSelection(circuit, {reveal: true});
    });
    return button;
  };
  const head = node('tr', {}, [node('th', {textContent: 'Bajada'}), node('th', {textContent: 'Total'}),
    ...times[0].map((_, i) => node('th', {}, [sectorButton('S' + (i + 1), i)]))]);
  const rows = data.map((d, n) => node('tr', {}, [
    node('td', {}, [Object.assign(node('i', {className: 'chip'}), {style: 'background:' + d.color}), node('span', {textContent: ' ' + when(d.run.started_at)})]),
    node('td', {className: 'time', textContent: formatMs(d.run.elapsed_ms) + (d === reference ? '' : ' (' + formatDelta(d.run.elapsed_ms - reference.run.elapsed_ms) + ')')}),
    ...times[n].map((t, i) => node('td', {className: t === best[i] ? 'best' : ''}, [sectorButton(formatMs(t), i)]))]));
  $('segments').replaceChildren(node('table', {className: 'standings'}, [node('thead', {}, [head]), node('tbody', {}, rows)]),
    node('p', {className: 'help', textContent: 'Pulsa un sector o su tiempo para verlo en amarillo en el mapa. En morado, el mejor tiempo de cada segmento.'}));
}

$('clearMapSelection').addEventListener('click', () => {
  mapSelection = null;
  const circuit = circuitOf($('circuitSelect').value);
  showSelection(circuit);
  if (circuit) view.fit(circuit.points.map(p => p.slice(0, 2)));
});

async function loadRoutes() {
  const routes = await shell.api.trainingRoutes();
  $('routesCount').textContent = routes.length ? routes.length + ' RUTA(S)' : '';
  $('routes').replaceChildren(...(routes.length ? routes.map(r => {
    const remove = node('button', {type: 'button', className: 'text-btn danger', textContent: 'Borrar'});
    remove.addEventListener('click', async () => {
      if (!window.confirm('¿Borrar la ruta «' + r.filename + '» y sus bajadas de entrenamiento?')) return;
      try {await shell.api.deleteTrainingRoute(r.id); await Promise.all([loadRoutes(), loadRuns()]); status('Ruta borrada.', 'success');}
      catch (err) {status(err.message, 'error');}
    });
    return node('div', {className: 'item'}, [node('span', {}, [node('b', {textContent: r.filename}),
      node('small', {textContent: ' · ' + dateText(r.recorded_at || r.created_at) + ' · ' + (r.distance_m ? km(r.distance_m) + ' · ' : '') +
        (r.runs ? r.runs + ' bajada(s)' : 'ningún circuito')})]), remove]);
  }) : [node('p', {className: 'placeholder', textContent: 'Todavía no has subido rutas.'})]));
}

$('routeFile').addEventListener('change', e => {
  const file = e.target.files[0];
  $('routeName').textContent = file ? file.name + ' · ' + Math.round(file.size / 1024) + ' KB' : 'Una salida completa: encontraremos las bajadas';
});
$('analyze').addEventListener('click', async () => {
  const file = $('routeFile').files[0];
  if (!file) return status('Elige primero un archivo GPX o TCX.', 'error');
  const btn = $('analyze');
  btn.disabled = true;
  status('Buscando circuitos en ' + file.name + '…');
  try {
    const result = await shell.api.uploadTrainingRoute(file);
    $('found').replaceChildren(...(result.found.length ? result.found.map(f => {
      const see = node('button', {type: 'button', className: 'btn outline small', textContent: 'Comparar'});
      see.addEventListener('click', () => loadRuns(f.circuit_id).catch(err => status(err.message, 'error')));
      return node('div', {className: 'item'}, [node('span', {}, [node('b', {textContent: f.circuit_name}),
        node('small', {textContent: ' · ' + f.runs + ' bajada(s)'})]), see]);
    }) : [node('p', {className: 'placeholder', textContent: 'En esta ruta no hay ninguna bajada completa de los circuitos de la aplicación.'})]));
    status(result.found.length ? 'Encontrado: ' + result.found.map(f => f.circuit_name + ' (' + f.runs + ')').join(', ') + '.' :
      'Ruta guardada, sin circuitos de la aplicación.', result.found.length ? 'success' : '');
    $('routeFile').value = ''; $('routeName').textContent = 'Una salida completa: encontraremos las bajadas';
    await Promise.all([loadRoutes(), loadRuns(result.found[0]?.circuit_id)]);
  } catch (err) {status('No se pudo analizar la ruta: ' + err.message, 'error');}
  finally {btn.disabled = false;}
});
$('circuitSelect').addEventListener('change', pickDefault);
$('loginButton').addEventListener('click', () => shell.askLogin('Entra o crea tu cuenta para guardar tus rutas.'));
let resizeTimer;
window.addEventListener('resize', () => {clearTimeout(resizeTimer); resizeTimer = setTimeout(() => compare().catch(() => {}), 250);});

async function start() {
  shell = await startShell('entrenamiento');
  if (!shell.api) {$('needLogin').hidden = false; $('needLogin').textContent = 'Esta página necesita el servidor de DH Trails.'; return;}
  const show = async () => {
    $('needLogin').hidden = !!shell.me;
    $('workspace').hidden = !shell.me;
    if (!shell.me) return;
    view.map.invalidateSize();
    catalog = await shell.api.circuitCatalog();
    await Promise.all([loadRoutes(), loadRuns()]);
  };
  shell.onUser(() => show().catch(err => status(err.message, 'error')));
  await show();
}
start().catch(err => status('Error: ' + err.message, 'error'));
