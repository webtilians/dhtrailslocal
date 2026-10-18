// DH Trails v0.8 — Entrenamiento: upload routes, find the app's circuits in them, overlay runs.
import {formatMs, formatDelta} from './sector-comparison.mjs';
import {resample, gapSeries, segmentTimes, circuitPosition, circuitStretch, trailOffsets, steadySpeed, inBlind, brakingPoints, timeAt,
  positionAt, timeLost, lossZones}
  from './telemetry.mjs';
import {lineChart} from './charts.mjs';
import {distanceSeries} from './gps-engine.mjs';
import {$, node, say, startShell, createMap, km, dateText} from './app-shell.mjs';
import {readGoproTelemetry, telemetryGpx, videoMoments} from './gopro.mjs';

// Categorical slots validated for the dark panel surface (CVD-safe in this order, max 4 runs).
const COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500'];
const view = createMap('map');
let shell = null, catalog = [], runs = [], picked = [];
const profiles = new Map();
const status = (message, type = '') => say($('status'), message, type);
// Day and hour tell apart several runs of the same outing.
const when = iso => iso ? new Date(iso).toLocaleString('es-ES', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}) : '—';
// A friend's run carries their name; yours do not.
const runLabel = r => (r.mine === false ? r.pilot + ' · ' : '') + when(r.started_at) + ' · ' + formatMs(r.elapsed_ms);
const circuitOf = id => catalog.find(c => c.id === id);
const HIGHLIGHT = '#ffe066';
let mapSelection = null, selectionLayer = null, charts = [], comparisonVersion = 0;
// Braking of up to two of the compared runs at once (null: the reference and the next one).
const BRAKING_MAX = 2;
let current = null, brakingIds = null, brakingByHand = false, brakingLayer = null;
const kmh = v => Math.round(v) + ' km/h';
const seconds = ms => (ms / 1000).toFixed(1).replace('.', ',') + ' s';
const zoneText = z => 'de ' + Math.round(z.fromKmh) + ' a ' + kmh(z.toKmh) + ' en ' + Math.round(z.to - z.from) + ' m';
const whose = r => r.mine === false ? 'la de ' + r.pilot + ' (' + when(r.started_at) + ')' : 'la tuya (' + when(r.started_at) + ')';
const owner = r => (r.mine === false ? r.pilot : 'tu bajada') + ' (' + when(r.started_at) + ')';
const capital = text => text[0].toUpperCase() + text.slice(1);

function showSelection(circuit, {reveal = false} = {}) {
  if (selectionLayer) view.map.removeLayer(selectionLayer);
  selectionLayer = null;
  const chartMark = {point: mapSelection?.metres, zone: mapSelection?.from}[mapSelection?.kind];
  charts.forEach(chart => chart?.setSelection(chartMark === undefined ? null : chartMark / 1000));
  document.querySelectorAll('#segments [data-segment]').forEach(button => {
    const active = mapSelection?.kind === 'segment' && Number(button.dataset.segment) === mapSelection.index;
    button.setAttribute('aria-pressed', String(active));
    button.closest('td, th').classList.toggle('segment-selected', active);
  });
  document.querySelectorAll('#brakingList [data-zone]').forEach(button =>
    button.setAttribute('aria-pressed', String(mapSelection?.kind === 'zone' && Number(button.dataset.zone) === mapSelection.index)));
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
  } else if (mapSelection.kind === 'zone') {
    const points = circuitStretch(circuit.points, distances, mapSelection.from, mapSelection.to);
    selectionLayer = L.layerGroup([
      L.polyline(points, {color: '#071423', weight: 14, opacity: 1}),
      L.polyline(points, {color: HIGHLIGHT, weight: 8, opacity: 1}),
    ]).addTo(view.map);
    $('mapSelection').textContent = (mapSelection.title || 'Frenada ' + (mapSelection.index + 1)) + ' resaltada · ' + Math.round(mapSelection.from) + '–' +
      Math.round(mapSelection.to) + ' m desde la salida · ' + mapSelection.text;
    if (reveal) view.map.fitBounds(L.latLngBounds(points), {padding: [80, 80], maxZoom: 18});
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
  seekVideo(kilometres * 1000);
}

async function loadRuns(keepCircuit) {
  runs = await shell.api.trainingRuns(null, {friends: true});
  const counts = new Map();
  for (const r of runs) {
    const c = counts.get(r.circuit_id) || {mine: 0, friends: 0};
    c[r.mine === false ? 'friends' : 'mine']++;
    counts.set(r.circuit_id, c);
  }
  const select = $('circuitSelect');
  const previous = keepCircuit || select.value;
  select.replaceChildren(...(counts.size ? [...counts].map(([id, n]) => node('option', {value: id,
    textContent: (circuitOf(id)?.name || runs.find(r => r.circuit_id === id).circuit_name) + ' · ' + n.mine + ' tuya(s)' +
      (n.friends ? ' · ' + n.friends + ' de amigos' : '')})) :
    [node('option', {value: '', textContent: 'Sin bajadas todavía: sube una ruta'})]));
  if (counts.has(previous)) select.value = previous;
  pickDefault();
}

// By default compare your best run with your friends' best, or else with your latest one.
function pickDefault() {
  const here = runs.filter(r => r.circuit_id === $('circuitSelect').value);
  const mine = here.filter(r => r.mine !== false), theirs = here.filter(r => r.mine === false);
  const fastest = list => [...list].sort((a, b) => a.elapsed_ms - b.elapsed_ms)[0];
  picked = [...new Set([fastest(mine), fastest(theirs), ...mine, ...theirs].filter(Boolean).map(r => r.id))].slice(0, 2);
  renderRunList();
  compare().catch(err => status(err.message, 'error'));
}
function renderRunList() {
  const here = runs.filter(r => r.circuit_id === $('circuitSelect').value);
  // Yours first, then each friend's, newest first within each rider.
  const ordered = [...here.filter(r => r.mine !== false),
    ...here.filter(r => r.mine === false).sort((a, b) => a.pilot.localeCompare(b.pilot) || b.started_at.localeCompare(a.started_at))];
  const firstFriend = ordered.find(r => r.mine === false);
  $('runList').replaceChildren(...ordered.flatMap(r => {
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
    const option = node('label', {className: 'run-option' + (slot >= 0 ? ' on' : '')}, [box, chip,
      node('span', {textContent: runLabel(r)}), node('small', {textContent: r.tournament_name ? 'Torneo · ' + r.tournament_name : r.source_filename || ''})]);
    return r === firstFriend ? [node('div', {className: 'run-group', textContent: 'De tus amigos'}), option] : [option];
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
  current = null;
  if (selectionLayer) view.map.removeLayer(selectionLayer);
  if (brakingLayer) view.map.removeLayer(brakingLayer);
  selectionLayer = brakingLayer = null;
  view.clear();
  ['legend', 'speedChart', 'gapChart', 'segments', 'brakingRuns', 'brakingList'].forEach(id => $(id).replaceChildren());
  showSelection(circuit);
  if (!circuit) {$('compareTag').textContent = '—'; return;}
  $('compareTag').textContent = circuit.name.toUpperCase();
  const pts = circuit.points.map(p => [p[0], p[1]]);
  view.add(L.polyline(pts, {color: '#5d7c99', weight: 8, opacity: .45}));
  view.fit(pts);
  const chosen = picked.map(id => runs.find(r => r.id === id)).filter(Boolean);
  if (!chosen.length) {
    $('segments').replaceChildren(node('p', {className: 'placeholder', textContent: 'Elige bajadas para compararlas.'}));
    $('brakingList').replaceChildren(node('p', {className: 'placeholder', textContent: 'Elige una bajada para ver dónde frena.'}));
    return;
  }
  const distances = distanceSeries(circuit.points);
  const data = await Promise.all(chosen.map(async (r, i) => {
    const profile = await profileOf(r.id);
    // Speed without the GPS spikes: fixes far off the trail or out of reach are left out.
    const speed = steadySpeed(profile, trailOffsets(profile, circuit.points, distances));
    return {run: r, color: COLORS[i], label: runLabel(r), profile, samples: resample(profile, 10), speed};
  }));
  if (version !== comparisonVersion) return;
  // Each run's own GPS line, in its colour.
  for (const d of data) view.add(L.polyline(d.profile.map(p => [p[2], p[3]]), {color: d.color, weight: 3, opacity: .95}))
    .bindTooltip(d.label, {sticky: true});
  const fastest = data.reduce((a, b) => b.run.elapsed_ms < a.run.elapsed_ms ? b : a);
  const reference = data.find(d => d.run.id === referenceId) || fastest;
  $('referenceSelect').replaceChildren(node('option', {value: '', textContent: 'La más rápida (' + fastest.label + ')'}),
    ...data.map(d => node('option', {value: d.run.id, textContent: d.label + (clip?.runId === d.run.id ? ' · vídeo' : '')})));
  $('referenceSelect').value = reference === fastest && referenceId !== fastest.run.id ? '' : reference.run.id;
  $('legend').replaceChildren(...data.map(d => node('span', {className: 'legend-item'}, [
    Object.assign(node('i', {className: 'chip'}), {style: 'background:' + d.color}),
    node('span', {textContent: d.label + (d === reference ? ' · referencia' : '')})])));
  current = {circuit, data, reference};
  charts.push(null);   // the speed chart, drawn with the braking zones
  // Where each run loses or gains time against the reference, every 25 m, as a strip under the chart.
  const others = data.filter(d => d !== reference);
  const lost = new Map(others.map(d => [d, timeLost(d.profile, reference.profile, 25)]));
  charts.push(lineChart($('gapChart'), {series: data.map(d => ({label: d.label, color: d.color,
    points: gapSeries(d.samples, reference.samples).map(p => ({x: p.s / 1000, y: p.ms / 1000}))})),
    lanes: others.map(d => ({chip: d.color, spans: lost.get(d).filter(x => Math.abs(x.ms) > 50).map(x => ({from: x.from / 1000, to: x.to / 1000,
      color: x.ms > 0 ? LOSS : GAIN, opacity: Math.min(1, 0.3 + Math.abs(x.ms) / 800)}))})),
    yFormat: v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + ' s', zero: true,
    onSelect: (x, options) => selectPoint(circuit, x, options)}));
  renderSegments(circuit, data, reference);
  renderLosses(circuit, reference, others, lost);
  // Braking shows the reference and the next run, unless you picked the runs yourself: that choice
  // stays while those runs are compared (an empty one too).
  const present = (brakingIds || []).filter(id => data.some(d => d.run.id === id));
  brakingByHand &&= present.length > 0 || !brakingIds.length;
  const byDefault = [reference, ...data.filter(d => d !== reference)].map(d => d.run.id);
  brakingIds = brakingByHand ? present : byDefault.slice(0, BRAKING_MAX);
  renderBraking();
  if (clip) renderMoments();
  $('replayTime').max = replayEnd();
  replay.ms = Math.min(replay.ms, replayEnd());
  drawReplay();
  const gates = gatesOf(circuit), referenceTimes = segmentTimes(reference.profile, gates);
  const worst = data.filter(d => d !== reference).map(d => {
    const lost = segmentTimes(d.profile, gates).map((t, i) => t - referenceTimes[i]);
    const i = lost.indexOf(Math.max(...lost));
    return d.label + ' pierde más en el segmento ' + (i + 1) + ' (' + formatDelta(lost[i]) + ')';
  });
  status(worst.length ? worst.join(' · ') + '.' : 'Elige otra bajada para compararla con esta.', 'success');
}
// Braking of one or two runs, corner by corner: on the circuit in each run's colour (with two, the
// first outside and the second inside), as strips under the speed chart and as a list that says
// which run gets through each corner faster and why.
function renderBraking() {
  if (!current) return;
  const {circuit, data, reference} = current;
  if (brakingLayer) view.map.removeLayer(brakingLayer);
  brakingLayer = null;
  const chosen = data.filter(d => brakingIds.includes(d.run.id)), key = chosen.map(d => d.run.id).join();
  const points = chosen.length ? brakingPoints(chosen.map(d => ({profile: d.profile, speed: d.speed}))) : [];
  if (mapSelection?.kind === 'zone' && (mapSelection.key !== key || !points[mapSelection.index])) mapSelection = null;
  $('brakingRuns').replaceChildren(...data.map(d => {
    const on = chosen.includes(d);
    const box = node('input', {type: 'checkbox', checked: on});
    box.addEventListener('change', () => {
      if (box.checked && chosen.length >= BRAKING_MAX) {box.checked = false; return status('Puedes solapar las frenadas de 2 bajadas a la vez.', 'error');}
      brakingIds = box.checked ? [...brakingIds, d.run.id] : brakingIds.filter(id => id !== d.run.id);
      brakingByHand = true;
      renderBraking();
    });
    const chip = node('i', {className: 'chip'});
    chip.style.background = d.color;
    return node('label', {className: 'run-option' + (on ? ' on' : '')}, [box, chip,
      node('span', {textContent: d.label + (d === reference ? ' · referencia' : '')})]);
  }));
  const span = p => {
    const found = p.zones.filter(Boolean);
    return {from: Math.min(...found.map(z => z.from)), to: Math.max(...found.map(z => z.to))};
  };
  charts[0] = lineChart($('speedChart'), {series: data.map(d => ({label: d.label, color: d.color,
    points: d.speed.samples.map((p, i) => ({x: p.s / 1000, y: d.speed.kmh[i] === null ? null : Math.round(d.speed.kmh[i] * 10) / 10,
      est: inBlind(d.speed.blind, p.s)}))})),
    bands: points.map(p => ({from: span(p).from / 1000, to: span(p).to / 1000})),
    lanes: chosen.map((d, k) => ({color: d.color, spans: points.filter(p => p.zones[k]).map(p => ({from: p.zones[k].from / 1000, to: p.zones[k].to / 1000})),
      unknown: d.speed.blind.map(([a, b]) => ({from: Math.min(a, b) / 1000, to: Math.max(a, b) / 1000}))})),
    yFormat: kmh, onSelect: (x, options) => selectPoint(circuit, x, options)});
  if (!chosen.length) {
    $('brakingList').replaceChildren(node('p', {className: 'placeholder', textContent: 'Marca una o dos bajadas para ver sus frenadas.'}));
    return showSelection(circuit);
  }
  const distances = distanceSeries(circuit.points);
  const two = chosen.length === 2;
  const styles = two ? [{casing: 22, line: 15}, {casing: 9, line: 5}] : [{casing: 12, line: 6}];
  const layers = [];
  // Outside lines first, so the second run's lines stay on top of them.
  chosen.forEach((d, k) => points.forEach((p, i) => {
    const z = p.zones[k];
    if (!z) return;
    const stretch = circuitStretch(circuit.points, distances, z.from, z.to);
    layers.push(L.polyline(stretch, {color: '#071423', weight: styles[k].casing, opacity: .95}),
      L.polyline(stretch, {color: d.color, weight: styles[k].line, opacity: 1})
        .bindTooltip('Frenada ' + (i + 1) + ' · ' + capital(whose(d.run)) + ': ' + zoneText(z), {sticky: true}));
  }));
  points.forEach((p, i) => {
    const number = L.divIcon({html: '<div class="brake-pin">' + (i + 1) + '</div>', className: '', iconSize: [22, 22], iconAnchor: [11, 11]});
    layers.push(L.marker(circuitPosition(circuit.points, distances, span(p).from), {icon: number, keyboard: false})
      .bindTooltip('Frenada ' + (i + 1) + ' · ' + Math.round(span(p).from) + '–' + Math.round(span(p).to) + ' m', {direction: 'top', offset: [0, -10]}));
  });
  brakingLayer = L.layerGroup(layers).addTo(view.map);
  $('brakingList').replaceChildren(...(points.length ? points.map((p, i) => {
    const rows = chosen.map((d, k) => {
      const z = p.zones[k], chip = node('i', {className: 'chip'});
      chip.style.background = d.color;
      return node('span', {className: 'zone-row'}, [chip, node('span', {textContent:
        (d.run.mine === false ? d.run.pilot + ' · ' : '') + when(d.run.started_at) + ': ' +
        (z ? 'frena desde ' + Math.round(z.from) + ' m, ' + zoneText(z) : withoutBraking(p.speed[k])) + ' · pasa en ' + seconds(p.ms[k])})]);
    });
    const summary = two ? brakingVerdict(p, chosen) : zoneText(p.zones[0]);
    const button = node('button', {type: 'button', className: 'zone-item', title: 'Ver la frenada ' + (i + 1) + ' en el mapa'}, [
      node('b', {className: 'brake-pin', textContent: i + 1}),
      node('span', {className: 'zone-body'}, [
        node('small', {textContent: Math.round(p.from) + '–' + Math.round(p.to) + ' m desde la salida'}), ...rows,
        ...(two ? [node('span', {className: 'zone-verdict', textContent: summary})] : [])])]);
    button.dataset.zone = i;
    button.addEventListener('click', () => {
      mapSelection = {kind: 'zone', circuitId: circuit.id, key, index: i, from: p.from, to: p.to, text: summary};
      showSelection(circuit, {reveal: true});
      seekVideo(p.from);
    });
    return button;
  }) : [node('p', {className: 'placeholder', textContent: 'No hay frenadas claras, o el GPS no fue fiable donde se frena.'})]));
  showSelection(circuit);
}
// What a run does at a braking point where it has no clear braking of its own.
function withoutBraking({topKmh, lowKmh, unsure}) {
  if (unsure) return 'aquí su GPS no es fiable y no se puede medir cómo frena';
  if (topKmh === null) return 'sin datos';
  const top = Math.round(topKmh), low = Math.round(lowKmh);
  if (top - low >= 5) return 'baja de ' + top + ' a ' + low + ' km/h poco a poco, sin una frenada clara';
  if (top - low >= 2) return 'apenas frena: de ' + top + ' a ' + low + ' km/h';
  return 'no frena: va a unos ' + low + ' km/h';
}
// Which of two runs gets through a braking point faster, and what it does differently. The figures
// are compared rounded like on screen, so the differences match them.
function brakingVerdict(p, runs) {
  const lost = p.ms[1] - p.ms[0];
  const doubtful = runs.filter((_, k) => p.speed[k].unsure).map(d => owner(d.run));
  const note = doubtful.length ? ' Ojo: aquí el GPS de ' + doubtful.join(' y de ') + ' no es fiable, así que su frenada no se puede comparar.' : '';
  if (Math.abs(lost) < 100) return 'Las dos pasan en el mismo tiempo.' + note;
  const f = lost > 0 ? 0 : 1, o = 1 - f, quick = p.zones[f], slow = p.zones[o];
  const why = [];
  let despite = '';
  if (!doubtful.length && quick && slow) {
    const later = Math.round(quick.from - slow.from), exit = Math.round(quick.toKmh) - Math.round(slow.toKmh);
    if (Math.abs(later) >= 10) why.push('frena ' + Math.abs(later) + ' m ' + (later > 0 ? 'más tarde' : 'antes'));
    if (Math.abs(exit) >= 2) why.push('sale ' + Math.abs(exit) + ' km/h más ' + (exit > 0 ? 'rápida' : 'despacio'));
  } else if (!doubtful.length && p.speed[f].lowKmh !== null && p.speed[o].lowKmh !== null) {
    const kept = Math.round(p.speed[f].lowKmh), other = Math.round(p.speed[o].lowKmh);
    if (kept - other >= 2) why.push('no baja de ' + kept + ' km/h y la otra baja a ' + other);
    else if (other - kept >= 2) despite = ', aunque baja más (a ' + kept + ' km/h; la otra a ' + other + ')';
  }
  return capital(whose(runs[f].run)) + ' es ' + seconds(Math.abs(lost)) + ' más rápida aquí' + (why.length ? ': ' + why.join(' y ') : '') +
    despite + '.' + note;
}
// For each run, the stretches where it loses most time against the reference (and where it gains
// most): what to work on, day by day. Each one shows on the map and moves the video or the replay there.
function renderLosses(circuit, reference, others, lost) {
  if (!others.length) return $('lossList').replaceChildren();
  $('lossList').replaceChildren(node('p', {className: 'loss-title', textContent: 'Dónde pierde o gana cada bajada frente a ' + reference.label}),
    ...others.map(d => {
      const zones = lossZones(lost.get(d));
      const worst = zones.filter(z => z.ms > 0).slice(0, 3), best = zones.filter(z => z.ms < 0).slice(0, 3);
      const chip = node('i', {className: 'chip'});
      chip.style.background = d.color;
      const items = [...worst, ...best].sort((a, b) => a.from - b.from).map(z => {
        const text = (z.ms > 0 ? 'Pierde ' : 'Gana ') + decimal(Math.abs(z.ms) / 1000) + ' s de ' + Math.round(z.from) + ' a ' + Math.round(z.to) + ' m';
        const b = node('button', {type: 'button', className: 'loss ' + (z.ms > 0 ? 'lose' : 'gain'), textContent: text});
        b.addEventListener('click', () => {
          mapSelection = {kind: 'zone', circuitId: circuit.id, key: 'loss', index: -1, title: 'Tramo', from: z.from, to: z.to,
            text: shortLabel(d.run) + ' ' + text.toLowerCase()};
          showSelection(circuit, {reveal: true});
          seekVideo(z.from);
        });
        return b;
      });
      return node('div', {className: 'loss-run'}, [node('div', {className: 'loss-head'}, [chip,
        node('span', {textContent: d.label + ' · ' + formatDelta(d.run.elapsed_ms - reference.run.elapsed_ms) + ' en total'})]),
        node('div', {className: 'loss-items'}, items.length ? items : [node('small', {textContent: 'Sin tramos con más de 0,3 s de diferencia.'})])]);
    }));
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
      seekVideo(i ? gatesOf(circuit)[i - 1] : 0);
    });
    return button;
  };
  const head = node('tr', {}, [node('th', {textContent: 'Bajada'}), node('th', {textContent: 'Total'}),
    ...times[0].map((_, i) => node('th', {}, [sectorButton('S' + (i + 1), i)]))]);
  const rows = data.map((d, n) => node('tr', {}, [
    node('td', {}, [Object.assign(node('i', {className: 'chip'}), {style: 'background:' + d.color}), node('span', {textContent: ' ' + (d.run.mine === false ? d.run.pilot + ' · ' : '') + when(d.run.started_at)})]),
    node('td', {className: 'time', textContent: formatMs(d.run.elapsed_ms) + (d === reference ? '' : ' (' + formatDelta(d.run.elapsed_ms - reference.run.elapsed_ms) + ')')}),
    ...times[n].map((t, i) => node('td', {className: t === best[i] ? 'best' : ''}, [sectorButton(formatMs(t), i)]))]));
  $('segments').replaceChildren(node('table', {className: 'standings'}, [node('thead', {}, [head]), node('tbody', {}, rows)]),
    node('p', {className: 'help', textContent: 'Pulsa un sector o su tiempo para verlo en amarillo en el mapa. En morado, el mejor tiempo de cada segmento.'}));
}

async function loadFriends() {
  const {friends, incoming, outgoing} = await shell.api.friends();
  $('friendsCount').textContent = friends.length ? friends.length + ' AMIGO(S)' : '';
  const button = (text, className, action) => {
    const b = node('button', {type: 'button', className, textContent: text});
    b.addEventListener('click', () => action().catch(err => say($('friendFeedback'), err.message, 'error')));
    return b;
  };
  const row = (name, note, actions) => node('div', {className: 'item'}, [
    node('span', {}, [node('b', {textContent: name}), ...(note ? [node('small', {textContent: ' · ' + note})] : [])]),
    node('span', {className: 'row-actions'}, actions)]);
  const refresh = async message => {
    await Promise.all([loadFriends(), loadRuns()]);
    if (message) say($('friendFeedback'), message, 'success');
  };
  const items = [
    ...incoming.map(f => row(f.name, 'quiere ser tu amigo', [
      button('Aceptar', 'btn outline small', async () => {await shell.api.acceptFriend(f.id); await refresh('Ahora ' + f.name + ' y tú veis vuestras bajadas.');}),
      button('Rechazar', 'text-btn danger', async () => {await shell.api.removeFriend(f.id); await refresh();})])),
    ...friends.map(f => row(f.name, '', [button('Quitar', 'text-btn danger', async () => {
      if (!window.confirm('¿Dejar de compartir bajadas con ' + f.name + '?')) return;
      await shell.api.removeFriend(f.id); await refresh('Ya no compartís bajadas.');})])),
    ...outgoing.map(f => row(f.name, 'solicitud enviada', [
      button('Cancelar', 'text-btn danger', async () => {await shell.api.removeFriend(f.id); await refresh();})])),
  ];
  $('friendsList').replaceChildren(...(items.length ? items : [node('p', {className: 'placeholder', textContent: 'Todavía no tienes amigos en la app.'})]));
}
async function inviteFriend() {
  const name = $('friendName').value.trim();
  if (!name) return say($('friendFeedback'), 'Escribe el nombre de piloto de tu amigo.', 'error');
  try {
    const result = await shell.api.addFriend(name);
    $('friendName').value = '';
    say($('friendFeedback'), result.status === 'accepted' ? 'Ya sois amigos con ' + result.name + '.' :
      'Solicitud enviada a ' + result.name + '. Cuando la acepte, veréis vuestras bajadas.', 'success');
    await Promise.all([loadFriends(), loadRuns()]);
  } catch (err) {say($('friendFeedback'), err.message, 'error');}
}
$('addFriend').addEventListener('click', inviteFriend);
$('friendName').addEventListener('keydown', e => {if (e.key === 'Enter') {e.preventDefault(); inviteFriend();}});

$('clearMapSelection').addEventListener('click', () => {
  mapSelection = null;
  const circuit = circuitOf($('circuitSelect').value);
  showSelection(circuit);
  if (circuit) view.fit(circuit.points.map(p => p.slice(0, 2)));
});

// A route that passes a circuit's start and finish without following it in between (like on the
// way to other trails) is not a run of it, as in a time trial.
function skippedMessage(s) {
  return 'Pasas por «' + s.circuit_name + '», pero ' + s.reason + ': no cuenta como bajada.';
}
// Why a route gave no run: it rides part of a circuit, or the nearest circuit is somewhere else.
function noCircuitMessage(nearest) {
  if (!nearest) return 'Todavía no hay circuitos en la aplicación.';
  if (nearest.passes) return 'Pasas por «' + nearest.circuit_name + '», pero no hay una bajada completa de su salida a su meta.';
  return 'No contiene ningún circuito. El más cercano, «' + nearest.circuit_name + '», queda a ' +
    (nearest.distance_m >= 1000 ? km(nearest.distance_m) : nearest.distance_m + ' m') + ' de tu ruta.';
}
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
    }) : []), ...(result.skipped || []).map(s => node('p', {className: 'placeholder', textContent: skippedMessage(s)})),
      ...(result.found.length || result.skipped?.length ? [] : [node('p', {className: 'placeholder', textContent: noCircuitMessage(result.nearest)})]));
    const notCounted = (result.skipped || []).map(skippedMessage).join(' ');
    status(result.found.length ? 'Encontrado: ' + result.found.map(f => f.circuit_name + ' (' + f.runs + ')').join(', ') + '.' + (notCounted ? ' ' + notCounted : '') :
      'Ruta guardada. ' + (notCounted || noCircuitMessage(result.nearest)), result.found.length ? 'success' : '');
    $('routeFile').value = ''; $('routeName').textContent = 'Una salida completa: encontraremos las bajadas';
    await Promise.all([loadRoutes(), loadRuns(result.found[0]?.circuit_id)]);
  } catch (err) {status('No se pudo analizar la ruta: ' + err.message, 'error');}
  finally {btn.disabled = false;}
});
$('circuitSelect').addEventListener('change', pickDefault);
$('loginButton').addEventListener('click', () => shell.askLogin('Entra o crea tu cuenta para guardar tus rutas.'));
// ---- GoPro video, played from the rider's own device and kept in step with the map and charts ----
let clip = null, referenceId = null;
const LOSS = '#ff5c5c', GAIN = '#3fd0c9';
// The video's dots go above everything else on the map, numbered braking pins included.
view.map.createPane('videoNow').style.zIndex = 640;
const clock = s => Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0').replace('.', ',');
const madrid = ms => new Date(ms).toLocaleString('es-ES', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const videoSay = (message, type = '') => say($('videoInfo'), message, type);
const linked = () => current?.data.find(d => d.run.id === clip?.runId) || null;
const shortLabel = r => (r.mine === false ? r.pilot + ' · ' : '') + when(r.started_at);
const decimal = (x, n = 1) => x.toFixed(n).replace('.', ',');

const runAt = positionAt;
// The run whose time the video covers most: yours first, then your friends'.
function runInVideo(t) {
  const from = t.lag * 1000, to = (t.lag + t.seconds) * 1000;
  const overlap = r => Math.min(to, Date.parse(r.started_at) + r.elapsed_ms) - Math.max(from, Date.parse(r.started_at));
  return runs.filter(r => r.started_at && overlap(r) > 0)
    .sort((a, b) => (a.mine === false) - (b.mine === false) || overlap(b) - overlap(a))[0] || null;
}
async function linkVideo() {
  const t = clip.telemetry, run = runInVideo(t);
  $('videoActions').replaceChildren();
  $('videoActions').hidden = true;
  if (!run) {
    clip.runId = null;
    syncVideo();
    const upload = node('button', {type: 'button', className: 'btn outline', textContent: 'Usar el GPS de la GoPro'});
    upload.addEventListener('click', () => uploadGoproGps().catch(err => videoSay('No se pudo subir el GPS de la GoPro: ' + err.message, 'error')));
    $('videoActions').replaceChildren(upload);
    $('videoActions').hidden = false;
    return videoSay('El vídeo es del ' + madrid(t.lag * 1000) + ' (' + clock(t.seconds) + ') y no tienes ninguna bajada de ese momento. ' +
      'Sube la ruta de tu reloj de ese día, o usa el GPS de la propia GoPro: lo subimos como una ruta de entrenamiento y, si sigue un circuito, aparece la bajada.');
  }
  clip.runId = run.id;
  // The video's run becomes the reference: the others say where they lost or gained against it.
  referenceId = run.id;
  // Show that run: on its circuit and among the compared ones.
  if ($('circuitSelect').value !== run.circuit_id) {
    // With the best other run of that circuit, to race against while watching.
    $('circuitSelect').value = run.circuit_id;
    const best = runs.filter(r => r.circuit_id === run.circuit_id && r.id !== run.id).sort((a, b) => a.elapsed_ms - b.elapsed_ms)[0];
    picked = [run.id, ...(best ? [best.id] : [])];
  }
  else if (!picked.includes(run.id)) picked = [...picked.slice(0, COLORS.length - 1), run.id];
  renderRunList();
  await compare();
  clip.start = Date.parse(run.started_at) / 1000 - t.lag;
  videoSay('Vídeo de la bajada ' + (run.mine === false ? 'de ' + run.pilot + ' ' : '') + 'del ' + madrid(Date.parse(run.started_at)) +
    ' en ' + run.circuit_name + ': la salida está en el ' + clock(clip.start) + ' del vídeo y la meta en el ' +
    clock(clip.start + run.elapsed_ms / 1000) + '.', 'success');
  if (video().paused && video().currentTime < 0.1) video().currentTime = Math.max(0, clip.start - 2);
  renderMoments();
  syncVideo();
}
// Stops, hard braking, shocks and jumps of the run in the video, from the camera's own sensors.
function renderMoments() {
  const d = linked(), box = $('videoMoments');
  if (!clip || !d) return box.replaceChildren();
  const all = videoMoments(clip.telemetry, clip.start, clip.start + d.run.elapsed_ms / 1000);
  const of = kind => all.filter(m => m.kind === kind);
  const still = of('stop').reduce((sum, m) => sum + m.seconds, 0);
  const counts = [
    of('stop').length ? of('stop').length + ' parada(s), ' + decimal(still) + ' s quieto' : 'sin paradas',
    of('brake').length + ' frenada(s) fuertes', of('shock').length + ' golpe(s) de 4 g o más',
    of('air').length ? of('air').length + ' salto(s)' : 'ningún salto'];
  // Every stop, braking and jump; of the shocks, the five strongest.
  const strongest = of('shock').sort((a, b) => b.g - a.g).slice(0, 5);
  const shown = all.filter(m => m.kind !== 'shock' || strongest.includes(m));
  const text = m => ({
    stop: () => 'Parada de ' + decimal(m.seconds) + ' s',
    brake: () => 'Frenada de ' + Math.round(m.fromKmh) + ' a ' + Math.round(m.toKmh) + ' km/h en ' + decimal(m.until - m.t) + ' s (hasta ' + decimal(m.peak) + ' m/s²)',
    shock: () => 'Golpe de ' + decimal(m.g) + ' g',
    air: () => 'Salto: ' + decimal(m.seconds, 2) + ' s en el aire'})[m.kind]();
  box.replaceChildren(
    node('p', {className: 'moments-summary', textContent: 'En esta bajada: ' + counts.join(', ') + '.' +
      (still >= 1 ? ' Sin las paradas habrías tardado unos ' + decimal(d.run.elapsed_ms / 1000 - still) + ' s.' : '')}),
    ...shown.map(m => {
      const at = runAt(d.profile, (m.t - clip.start) * 1000);
      const button = node('button', {type: 'button', className: 'moment moment-' + m.kind}, [
        node('b', {textContent: clock(m.t)}), node('span', {textContent: text(m)}), node('small', {textContent: Math.round(at.s) + ' m'})]);
      button.addEventListener('click', () => {
        video().currentTime = Math.max(0, m.t - 1.5);
        syncVideo();
        $('videoBox').scrollIntoView({behavior: 'smooth', block: 'nearest'});
      });
      return button;
    }));
}
const video = () => $('video');
// Map point, chart cursor and the line under the video, at the video's current time.
function syncVideo() {
  const d = linked(), hud = $('videoHud');
  if (!clip || !d) {
    hud.textContent = clip ? 'Vídeo grabado el ' + madrid(clip.telemetry.lag * 1000) + '.' : '';
    return;
  }
  const ms = (video().currentTime - clip.start) * 1000;
  // The replay follows the video: every compared run where it was at this moment of the video's run.
  replay.ms = Math.min(replayEnd(), Math.max(0, ms));
  drawReplay();
  if (ms < 0 || ms > d.run.elapsed_ms) {
    hud.textContent = ms < 0 ? 'Antes de la salida: faltan ' + clock(-ms / 1000) : 'Después de la meta · ' + formatMs(d.run.elapsed_ms);
    return;
  }
  const at = runAt(d.profile, ms);
  // The camera's own speed at this frame (measured by its GPS ten times a second), else the run's.
  const near = clip.telemetry.points.reduce((best, p) => p.fix >= 2 && Math.abs(p.t - video().currentTime) < Math.abs(best.t - video().currentTime) ? p : best,
    {t: Infinity});
  const speed = Math.abs(near.t - video().currentTime) < 0.5 ? near.speed * 3.6 :
    d.speed.kmh[Math.min(d.speed.kmh.length - 1, Math.max(0, Math.round(at.s / 10)))];
  const ref = current.reference;
  const race = ref !== d ? ' · ' + formatDelta(ms - timeAt(ref.profile, at.s)) + ' frente a ' + shortLabel(ref.run) : '';
  hud.textContent = formatMs(ms) + ' · ' + (speed === null ? '—' : Math.max(0, Math.round(speed)) + ' km/h') + ' · ' + Math.round(at.s) + ' m' + race;
}
// Jump to the moment the run reached this many metres down the circuit: in the video when there is
// one, else in the replay (when the reference got there).
function seekVideo(metres) {
  const d = linked();
  if (!Number.isFinite(metres) || !current) return;
  if (!d) {
    replay.ms = Math.min(replayEnd(), timeAt(current.reference.profile, metres));
    return drawReplay();
  }
  video().currentTime = Math.min(video().duration || Infinity, Math.max(0, clip.start + timeAt(d.profile, metres) / 1000));
  syncVideo();
}

// ---- Replay: the compared runs on the map at once, as if they had started together ----
// Its clock is the video when there is one; else its own, at ×1, ×2 or ×4.
const replay = {ms: 0, playing: false, speed: 1, last: 0, frame: 0};
const replayDots = new Map();
const replayEnd = () => Math.max(0, ...(current?.data || []).map(d => d.run.elapsed_ms));
const replayShown = () => replay.ms > 0 || replay.playing || !!linked();
function drawReplay() {
  if (!current?.data.length || !replayShown()) {
    replayDots.forEach(dot => view.map.removeLayer(dot));
    replayDots.clear();
    $('replayBoard').replaceChildren(node('p', {className: 'placeholder', textContent: 'Pulsa ▶ para ver las bajadas a la vez en el mapa, como si hubieran salido juntas.'}));
    $('replayTime').value = 0; $('replayClock').textContent = formatMs(0);
    return;
  }
  const ms = replay.ms, ref = current.reference;
  for (const [id, dot] of replayDots)
    if (!current.data.some(d => d.run.id === id)) {view.map.removeLayer(dot); replayDots.delete(id);}
  const rows = current.data.map(d => {
    const t = Math.min(ms, d.run.elapsed_ms), at = runAt(d.profile, t), video = clip?.runId === d.run.id;
    // The video's run with a yellow ring, like the charts' cursor; the others with a white one.
    const style = {radius: video ? 10 : 8, color: video ? HIGHLIGHT : '#ffffff', weight: video ? 4 : 3, fillColor: d.color, fillOpacity: 1,
      interactive: false, pane: 'videoNow'};
    let dot = replayDots.get(d.run.id);
    if (!dot) replayDots.set(d.run.id, dot = L.circleMarker([at.lat, at.lon], style).addTo(view.map));
    else dot.setLatLng([at.lat, at.lon]).setStyle(style);
    if (video) dot.bringToFront();
    // Ahead (−) or behind (+) the reference at this point of the circuit; at the finish, the final gap.
    const gap = d === ref ? null : t >= d.run.elapsed_ms ? d.run.elapsed_ms - ref.run.elapsed_ms : t - timeAt(ref.profile, at.s);
    return {d, at, done: t >= d.run.elapsed_ms, gap};
  });
  $('replayBoard').replaceChildren(...[...rows].sort((a, b) => b.at.s - a.at.s).map(r => {
    const chip = node('i', {className: 'chip'});
    chip.style.background = r.d.color;
    return node('div', {className: 'replay-row'}, [chip, node('span', {textContent: r.d.label}),
      node('small', {textContent: r.done ? 'en meta' : Math.round(r.at.s) + ' m'}),
      node('b', {className: r.gap === null ? '' : r.gap > 0 ? 'behind' : 'ahead', textContent: r.gap === null ? 'referencia' : formatDelta(r.gap)})]);
  }));
  $('replayTime').value = ms;
  $('replayClock').textContent = formatMs(ms);
  const focus = rows.find(r => r.d.run.id === clip?.runId) || rows.find(r => r.d === ref);
  if (focus) charts.forEach(chart => chart?.setSelection(focus.at.s / 1000));
}
function tick(now) {
  if (!replay.playing) return;
  replay.ms = Math.min(replayEnd(), replay.ms + (now - replay.last) * replay.speed);
  replay.last = now;
  drawReplay();
  if (replay.ms >= replayEnd()) return stopReplay();
  replay.frame = requestAnimationFrame(tick);
}
function stopReplay() {
  replay.playing = false;
  cancelAnimationFrame(replay.frame);
  playButton();
}
const playButton = () => {
  const running = linked() ? !video().paused : replay.playing;
  $('replayPlay').textContent = running ? '❚❚ Pausa' : '▶ Reproducir';
};
$('replayPlay').addEventListener('click', () => {
  if (!current?.data.length) return status('Elige primero las bajadas que quieres ver.', 'error');
  if (linked()) {
    video().playbackRate = replay.speed;
    return video().paused ? video().play() : video().pause();
  }
  if (replay.playing) return stopReplay();
  if (replay.ms >= replayEnd()) replay.ms = 0;
  replay.playing = true;
  replay.last = performance.now();
  playButton();
  replay.frame = requestAnimationFrame(tick);
});
document.querySelectorAll('.replay-speeds button').forEach(b => b.addEventListener('click', () => {
  replay.speed = Number(b.dataset.speed);
  document.querySelectorAll('.replay-speeds button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  if (linked()) video().playbackRate = replay.speed;
}));
$('replayTime').addEventListener('input', e => {
  const ms = Number(e.target.value);
  if (linked()) {video().currentTime = Math.max(0, clip.start + ms / 1000); return syncVideo();}
  replay.ms = ms;
  drawReplay();
});
$('referenceSelect').addEventListener('change', e => {
  referenceId = e.target.value || null;
  compare().catch(err => status(err.message, 'error'));
});
async function uploadGoproGps() {
  const t = clip.telemetry, name = clip.name.replace(/\.(mp4|lrv)$/i, '') + ' (GPS de la GoPro).gpx';
  videoSay('Subiendo el GPS de la GoPro como ruta…');
  const result = await shell.api.uploadTrainingRoute(new File([telemetryGpx(t, name)], name, {type: 'application/gpx+xml'}));
  await Promise.all([loadRoutes(), loadRuns()]);
  if (result.found.length) return linkVideo();
  videoSay('Ruta guardada, pero no cuenta como bajada: ' + ((result.skipped || []).map(skippedMessage).join(' ') ||
    noCircuitMessage(result.nearest)) + ' El GPS de la GoPro suele ser menos preciso que el de un reloj.', 'error');
}
$('videoFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('videoName').textContent = file.name + ' · ' + (file.size / 1e9).toFixed(1).replace('.', ',') + ' GB';
  videoSay('Leyendo la telemetría de ' + file.name + '…');
  try {
    const telemetry = await readGoproTelemetry(file);
    if (!telemetry.good) throw new Error('el vídeo no tiene ningún punto con señal GPS');
    if (clip?.url) URL.revokeObjectURL(clip.url);
    clip = {file, name: file.name, telemetry, url: URL.createObjectURL(file), runId: null, start: 0};
    $('videoTag').textContent = (telemetry.camera || 'GOPRO').toUpperCase();
    video().src = clip.url;
    $('videoBox').hidden = false;
    await linkVideo();
  } catch (err) {videoSay('No se puede usar este vídeo: ' + err.message, 'error');}
});
video().addEventListener('timeupdate', syncVideo);
video().addEventListener('seeked', syncVideo);
// Smooth while playing, frame by frame where the browser allows it.
video().addEventListener('pause', () => playButton());
video().addEventListener('play', () => {
  playButton();
  const step = () => {if (video().paused) return; syncVideo(); video().requestVideoFrameCallback ? video().requestVideoFrameCallback(step) : requestAnimationFrame(step);};
  step();
});
// GoPro films in H.265: not every browser can show it. The map and the charts still follow the time.
video().addEventListener('error', () => videoSay('Este navegador no puede mostrar el vídeo (la GoPro graba en H.265). Prueba con Safari, ' +
  'o con Chrome o Edge al día, o con el archivo .LRV de la tarjeta, más ligero. La telemetría sí se ha leído.', 'error'));

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
    await Promise.all([loadRoutes(), loadRuns(), loadFriends()]);
  };
  shell.onUser(() => show().catch(err => status(err.message, 'error')));
  await show();
}
start().catch(err => status('Error: ' + err.message, 'error'));
