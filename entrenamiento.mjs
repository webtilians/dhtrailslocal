// DH Trails v0.8 — Entrenamiento: upload routes, find the app's circuits in them, overlay runs.
import {formatMs, formatDelta} from './sector-comparison.mjs';
import {resample, gapSeries, segmentTimes, circuitPosition, circuitStretch, trailOffsets, steadySpeed, inBlind, brakingPoints, timeAt,
  positionAt, timeLost, lossZones, brakingZones}
  from './telemetry.mjs';
import {lineChart} from './charts.mjs';
import {distanceSeries} from './gps-engine.mjs';
import {$, node, say, startShell, takeShared, createMap, km, dateText} from './app-shell.mjs';
import {cameraGps, readGoproTelemetry, telemetryGpx, videoMoments} from './gopro.mjs';
import {idealRun, progressSeries, runReport, worstStretch} from './insights.mjs';
import {runGates, gatesPassed, beep, unlockSound} from './gate-sounds.mjs';
import {youtubeLink, YouTubeVideo} from './youtube.mjs';

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
  renderEvolution(circuit);
  loadNotes(circuit).catch(() => {});
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
  renderMarks();
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

// ---- Your evolution on a circuit: a report of the latest run, the ideal run and the progress ----
const mineOn = circuit => runs.filter(r => r.mine !== false && r.circuit_id === circuit.id && r.started_at && r.elapsed_ms);
const day = iso => new Date(iso).toLocaleDateString('es-ES', {day: 'numeric', month: 'short'});
let evolutionVersion = 0;
// A run told against your earlier ones: total, sectors, and where you lose most against your best run.
async function reportText(run) {
  const circuit = circuitOf(run.circuit_id), mine = runs.filter(r => r.mine !== false && r.circuit_id === run.circuit_id && r.started_at);
  const r = runReport(run, mine), today = new Date(run.started_at).toDateString() === new Date().toDateString();
  const parts = [(today ? 'Hoy' : 'El ' + day(run.started_at)) + ' en ' + (circuit?.name || run.circuit_name) + ': ' + formatMs(run.elapsed_ms) +
    (!r.best ? ', tu primera bajada aquí.' : r.record ? ', ¡tu mejor tiempo! (' + formatDelta(r.vsBest) + ').' :
      ', ' + formatDelta(r.vsBest) + ' sobre tu mejor (' + day(r.best.started_at) + ')' +
      (r.previous && r.previous !== r.best ? ' y ' + formatDelta(r.vsPrevious) + ' frente a la anterior.' : '.'))];
  const sectors = [r.gained, r.lost].filter(Boolean).map(x => formatDelta(x.ms) + ' en S' + (x.sector + 1));
  if (sectors.length) parts.push('Frente a la anterior: ' + sectors.join(', ') + '.');
  if (r.margin) parts.push('Tu mayor margen, en S' + (r.margin.sector + 1) + ': ' + formatDelta(r.margin.ms).slice(1) + ' más que tu mejor S' + (r.margin.sector + 1) + '.');
  // Where it loses most against your best run, and whether the previous run lost there too.
  if (r.best && !r.record) {
    const [mineProfile, bestProfile] = await Promise.all([profileOf(run.id), profileOf(r.best.id)]);
    const worst = worstStretch(timeLost(mineProfile, bestProfile, 25));
    if (worst?.ms >= 300) {
      let again = false;
      if (r.previous && r.previous !== r.best) {
        const before = worstStretch(timeLost(await profileOf(r.previous.id), bestProfile, 25));
        again = !!before && before.from < worst.to && before.to > worst.from;
      }
      parts.push('Donde más pierdes frente a tu mejor bajada: del metro ' + Math.round(worst.from) + ' al ' + Math.round(worst.to) +
        ' (' + formatDelta(worst.ms) + ')' + (again ? ', como en la anterior.' : '.'));
    }
  }
  return parts.join(' ');
}
function renderEvolution(circuit) {
  const version = ++evolutionVersion, mine = mineOn(circuit);
  $('evolutionTag').textContent = mine.length ? mine.length + ' BAJADA(S) TUYAS' : 'TUS BAJADAS EN ESTE CIRCUITO';
  ['lastReport', 'progressChart', 'progressSectors'].forEach(id => $(id).replaceChildren());
  if (!mine.length) {
    $('idealRun').replaceChildren(node('p', {className: 'placeholder', textContent: 'Todavía no tienes bajadas en este circuito.'}));
    return;
  }
  const latest = mine.reduce((a, b) => Date.parse(b.started_at) > Date.parse(a.started_at) ? b : a);
  reportText(latest).then(text => {if (version === evolutionVersion) $('lastReport').replaceChildren(node('p', {className: 'report-line', textContent: text}));})
    .catch(() => {});
  renderIdeal(circuit, mine);
  renderProgress(mine);
}
// The best of each sector put together, and which day each came from.
function renderIdeal(circuit, mine) {
  const ideal = idealRun(mine);
  if (!ideal) return $('idealRun').replaceChildren(node('p', {className: 'placeholder', textContent: 'Hace falta el tiempo de cada sector: aún falta alguno en tus bajadas.'}));
  const fastest = ideal.fastest;
  const rows = ideal.sectors.map((s, i) => {
    const inFastest = fastest.sector_splits_ms?.[i];
    const go = node('button', {type: 'button', className: 'segment-button', textContent: 'S' + (i + 1), title: 'Ver el sector S' + (i + 1) + ' en el mapa'});
    go.addEventListener('click', () => {
      mapSelection = {kind: 'segment', circuitId: circuit.id, index: i};
      showSelection(circuit, {reveal: true});
      seekVideo(i ? gatesOf(circuit)[i - 1] : 0);
    });
    return node('tr', {}, [node('td', {}, [go]), node('td', {textContent: formatMs(s.ms)}),
      node('td', {textContent: when(s.run.started_at)}),
      node('td', {className: s.run === fastest ? 'best' : '', textContent: s.run === fastest ? 'es de tu mejor bajada' :
        Number.isFinite(inFastest) ? formatDelta(inFastest - s.ms) + ' en tu mejor bajada' : '—'})]);
  });
  $('idealRun').replaceChildren(
    node('p', {className: 'ideal-total'}, [node('b', {textContent: formatMs(ideal.ms)}),
      node('span', {textContent: ideal.margin > 300 ? ' si juntaras tu mejor sector de cada bajada: ' + seconds(ideal.margin) + ' menos que tu mejor tiempo (' +
        formatMs(fastest.elapsed_ms) + ', ' + day(fastest.started_at) + '). Ahí está tu margen.' :
        ' juntando tu mejor sector de cada bajada: tu mejor bajada (' + formatMs(fastest.elapsed_ms) + ') ya está casi ahí.'})]),
    node('table', {className: 'standings'}, [node('thead', {}, [node('tr', {}, ['Sector', 'Tu mejor', 'Día', 'Frente a tu mejor bajada'].map(t => node('th', {textContent: t})))]),
      node('tbody', {}, rows)]));
}
const SECTOR_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#a46bd9', '#e2557e', '#5fb8c9', '#8f9c3a'];
const clockTicks = v => {const m = Math.floor(v / 60), sec = Math.round(v - m * 60); return m + ':' + String(sec).padStart(2, '0');};
// Your times on the circuit along the days, and each sector over your best in it.
function renderProgress(mine) {
  // A run with a long stop (half as long again as your record) would flatten everything else.
  const record = Math.min(...mine.map(r => r.elapsed_ms)), kept = mine.filter(r => r.elapsed_ms <= record * 1.5);
  const p = progressSeries(kept), left = mine.length - kept.length;
  if (!p || p.points.length < 2) {
    $('progressChart').replaceChildren(node('p', {className: 'placeholder', textContent: 'Con una sola bajada aún no hay progreso que ver.'}));
    return;
  }
  const xFormat = x => day(new Date(p.first + x * 86400000).toISOString());
  const legend = items => node('div', {className: 'chart-legend'}, items.map(([label, color]) =>
    node('span', {className: 'legend-item'}, [Object.assign(node('i', {className: 'chip'}), {style: 'background:' + color}), node('span', {textContent: label})])));
  lineChart($('progressChart'), {height: 190, xFormat, yFormat: clockTicks, series: [
    {label: 'Tus bajadas', color: '#3987e5', points: p.points.map(q => ({x: q.x, y: q.total / 1000}))},
    {label: 'Tu récord', color: HIGHLIGHT, points: p.points.map(q => ({x: q.x, y: q.record / 1000}))}]});
  $('progressChart').prepend(legend([['Cada bajada', '#3987e5'], ['Tu récord hasta ese día', HIGHLIGHT]]));
  if (left) $('progressChart').append(node('p', {className: 'help', textContent: 'No se ven ' + left + ' bajada(s) con paradas largas (más de ' +
    formatMs(record * 1.5) + ').'}));
  if (!p.sectors) return;
  lineChart($('progressSectors'), {height: 170, xFormat, zero: true, yFormat: v => '+' + v.toFixed(0) + ' s',
    series: Array.from({length: p.sectors}, (_, i) => ({label: 'S' + (i + 1), color: SECTOR_COLORS[i % SECTOR_COLORS.length],
      points: p.points.filter(q => q.over[i] !== null).map(q => ({x: q.x, y: q.over[i] / 1000}))}))});
  $('progressSectors').prepend(legend(Array.from({length: p.sectors}, (_, i) => ['S' + (i + 1), SECTOR_COLORS[i % SECTOR_COLORS.length]])));
}

// ---- Notes: what you want to remember at a place of the circuit, seen again on every run there ----
let notes = [], notesCircuit = null, notesLayer = null;
async function loadNotes(circuit, force = false) {
  if (!force && notesCircuit === circuit.id) return renderNotes();
  notesCircuit = circuit.id;
  notes = await shell.api.trainingNotes(circuit.id);
  if (notesCircuit === circuit.id) renderNotes();
}
// Where a note would go now: the video's run, else the point picked on a chart or the map, else the replay.
function notePlace() {
  const circuit = circuitOf($('circuitSelect').value), d = linked();
  if (!circuit) return null;
  if (d && clip) {
    const ms = (video().currentTime - clip.start) * 1000;
    if (ms >= 0 && ms <= d.run.elapsed_ms) return {metres: runAt(d.profile, ms).s, attempt: d.run.id, where: 'donde va el vídeo'};
  }
  if (mapSelection?.circuitId === circuit.id) {
    if (mapSelection.kind === 'point') return {metres: mapSelection.metres, where: 'en el punto elegido'};
    if (mapSelection.kind === 'zone') return {metres: mapSelection.from, where: 'al principio del tramo elegido'};
    if (mapSelection.kind === 'segment') return {metres: mapSelection.index ? gatesOf(circuit)[mapSelection.index - 1] : 0, where: 'al principio del sector elegido'};
  }
  // With a video the replay follows it: before its start or after its finish there is no place yet.
  if (current && replayShown() && !(d && clip)) return {metres: runAt(current.reference.profile, Math.min(replay.ms, current.reference.run.elapsed_ms)).s,
    attempt: current.reference.run.id, where: 'donde va la repetición'};
  return null;
}
function showNotePlace() {
  const place = notePlace();
  say($('noteWhere'), place ? 'Se guardará en el metro ' + Math.round(place.metres) + ' (' + place.where + ').' :
    'Elige antes dónde: lleva el vídeo o la repetición a ese sitio, o pulsa un punto en una gráfica.', place ? '' : 'warning');
}
function renderNotes() {
  const circuit = circuitOf($('circuitSelect').value);
  if (notesLayer) view.map.removeLayer(notesLayer);
  notesLayer = null;
  if (!circuit || notesCircuit !== circuit.id) return;
  const distances = distanceSeries(circuit.points);
  notesLayer = L.layerGroup(notes.map(n => L.marker(circuitPosition(circuit.points, distances, n.metres), {
    icon: L.divIcon({html: '<div class="note-pin">📝</div>', className: '', iconSize: [24, 24], iconAnchor: [12, 22]}),
    pane: 'videoNow'}).bindTooltip('Metro ' + Math.round(n.metres) + ': ' + n.text, {direction: 'top', offset: [0, -18]}))).addTo(view.map);
  $('notesList').replaceChildren(...(notes.length ? notes.map(n => {
    const go = node('button', {type: 'button', className: 'text-btn', textContent: 'Ir'});
    go.addEventListener('click', () => {
      selectPoint(circuit, n.metres / 1000, {reveal: true});
      seekVideo(n.metres);
    });
    const remove = node('button', {type: 'button', className: 'text-btn danger', textContent: '✕', title: 'Borrar la nota'});
    remove.addEventListener('click', async () => {
      try {await shell.api.deleteTrainingNote(n.id); await loadNotes(circuit, true); renderMarks();}
      catch (err) {say($('noteWhere'), 'No se pudo borrar: ' + err.message, 'error');}
    });
    return node('div', {className: 'item note-item'}, [node('span', {}, [node('b', {textContent: 'Metro ' + Math.round(n.metres)}),
      node('span', {textContent: ' · ' + n.text}), node('small', {textContent: ' · ' + day(n.created_at)})]),
      node('span', {className: 'row-actions'}, [go, remove])]);
  }) : [node('p', {className: 'placeholder', textContent: 'Todavía no tienes notas en este circuito.'})]));
}
async function addNote() {
  const circuit = circuitOf($('circuitSelect').value), text = $('noteText').value.trim(), place = notePlace();
  if (!circuit) return say($('noteWhere'), 'Elige antes un circuito.', 'error');
  if (!text) return say($('noteWhere'), 'Escribe la nota.', 'error');
  if (!place) return showNotePlace();
  try {
    await shell.api.addTrainingNote({circuit_id: circuit.id, attempt_id: place.attempt || null, metres: Math.max(0, place.metres), text});
    $('noteText').value = '';
    say($('noteWhere'), 'Nota guardada en el metro ' + Math.round(place.metres) + '. La verás en el mapa y en la barra del vídeo de todas tus bajadas.', 'success');
    await loadNotes(circuit, true);
    renderMarks();
  } catch (err) {say($('noteWhere'), 'No se pudo guardar: ' + err.message, 'error');}
}
$('addNote').addEventListener('click', addNote);
$('noteText').addEventListener('keydown', e => {if (e.key === 'Enter') addNote();});
$('noteText').addEventListener('focus', showNotePlace);
$('noteHere').addEventListener('click', () => {
  if (linked()) video().pause();
  showNotePlace();
  $('notesPanel').scrollIntoView({behavior: 'smooth', block: 'center'});
  $('noteText').focus({preventScroll: true});
});

// ---- Under the video: its run's sectors, brakings and notes, to jump to them with one tap ----
function renderMarks() {
  const box = $('videoMarks'), d = linked(), circuit = current?.circuit;
  if (!clip || !d || !circuit) {box.hidden = true; return;}
  const span = d.run.elapsed_ms, at = ms => (Math.max(0, Math.min(span, ms)) / span * 100).toFixed(2) + '%';
  // A tap puts both videos there (each where its run was), a little before a braking or a note.
  const jump = (metres, lead = 0) => () => {pauseBoth(); seekBoth(metres, lead); syncVideo();};
  const mark = (className, left, title, metres, lead, width) => {
    const b = node('button', {type: 'button', className: 'mark ' + className, title, ariaLabel: title});
    b.style.left = left;
    if (width) b.style.width = width;
    b.addEventListener('click', event => {event.stopPropagation(); jump(metres, lead)();});
    return b;
  };
  const bounds = [0, ...gatesOf(circuit)];
  const sectors = bounds.map((m, i) => {
    const b = mark('mark-sector', at(i ? timeAt(d.profile, m) : 0), 'Sector S' + (i + 1), m, 0);
    b.textContent = 'S' + (i + 1);
    return b;
  });
  const brakes = brakingZones(d.profile, {speed: d.speed}).map(z => {
    const from = timeAt(d.profile, z.from), to = timeAt(d.profile, z.to);
    return mark('mark-brake', at(from), 'Frenada ' + zoneText(z) + ' (metro ' + Math.round(z.from) + ')', z.from, 1.5,
      'max(4px, ' + ((to - from) / span * 100).toFixed(2) + '%)');
  });
  const flags = notesCircuit === circuit.id ? notes.map(n => {
    const b = mark('mark-note', at(timeAt(d.profile, n.metres)), 'Nota en el metro ' + Math.round(n.metres) + ': ' + n.text, n.metres, 2);
    b.textContent = '📝';
    return b;
  }) : [];
  box.replaceChildren(node('div', {className: 'mark-track'}), ...brakes, ...sectors, ...flags, node('div', {className: 'mark-now'}));
  box.onclick = event => {
    const rect = box.getBoundingClientRect();
    jump(runAt(d.profile, (event.clientX - rect.left) / rect.width * span).s)();
  };
  box.hidden = false;
  moveMarks();
}
// The line of the bar at the video's moment.
function moveMarks() {
  const d = linked(), now = $('videoMarks').querySelector('.mark-now');
  if (!now || !d || !clip) return;
  const ms = (video().currentTime - clip.start) * 1000;
  now.style.left = (Math.max(0, Math.min(1, ms / d.run.elapsed_ms)) * 100).toFixed(2) + '%';
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
// Where the new runs leave the rider in each circuit's records (Récords), with a link to the table.
function recordLines(result) {
  return (result.records || []).map(r => {
    const name = result.found.find(f => f.circuit_id === r.circuit_id)?.circuit_name || 'el circuito';
    const text = !r.visible ? (r.rank === null && r.not_counted ? 'En ' + name + ' tu bajada no cuenta para los récords: el archivo parece editado o copiado.' :
        'En ' + name + ' no sales en los récords: lo elegiste en Récords.') :
      r.rank === null ? 'En ' + name + ' tu bajada no cuenta para los récords: el archivo parece editado o copiado.' :
      r.hot_seat && r.new_best ? '🔥 ¡Hot seat en ' + name + '! Tu ' + formatMs(r.elapsed_ms) + ' es el mejor tiempo' +
        (r.next ? ': le sacas ' + formatDelta(r.next.gap_ms).replace('+', '') + ' a ' + r.next.pilot + '.' : '.') :
      r.hot_seat ? 'Sigues en el hot seat de ' + name + ' con ' + formatMs(r.elapsed_ms) + '.' :
      r.rank === 1 ? 'En ' + name + ' empatas con el mejor tiempo (' + formatMs(r.elapsed_ms) + '), pero el hot seat sigue siendo de quien lo marcó antes.' :
      (r.new_best ? 'Nuevo récord tuyo en ' + name + ': ' : 'En ' + name + ' sigues ') + r.rank + 'º de ' + r.riders +
        ', a ' + formatDelta(r.gap_ms) + ' del hot seat' + (r.new_best ? '' : ' (tu mejor: ' + formatMs(r.elapsed_ms) + ')') + '.';
    return node('p', {className: 'report-line'}, [text + ' ', node('a', {href: './records.html#' + r.circuit_id, textContent: 'Ver récords'})]);
  });
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
  // Chosen from «Subir ruta» at the top: analysed right away, and the page goes to the result below.
  if (file && quickUpload) {
    quickUpload = false;
    $('analyze').closest('.panel').scrollIntoView({behavior: 'smooth', block: 'start'});
    $('analyze').click();
  }
});
let quickUpload = false;
$('quickUpload').addEventListener('click', () => {quickUpload = true; $('routeFile').click();});
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
    // What each new run says against your earlier ones, without having to read the charts.
    const lines = await Promise.all((result.runs || []).slice(0, 4).map(r => runs.find(x => x.id === r.id)).filter(Boolean)
      .map(r => reportText(r).catch(() => null)));
    $('found').prepend(...recordLines(result), ...lines.filter(Boolean).map(text => node('p', {className: 'report-line', textContent: text})));
  } catch (err) {status('No se pudo analizar la ruta: ' + err.message, 'error');}
  finally {btn.disabled = false;}
});
$('circuitSelect').addEventListener('change', pickDefault);
$('loginButton').addEventListener('click', () => shell.askLogin('Entra o crea tu cuenta para guardar tus rutas.'));
// ---- GoPro video, played from the rider's own device and kept in step with the map and charts ----
let clip = null, clipB = null, referenceId = null;
// loop: a stretch played over and over; anchor: both runs' times where the two videos started playing
// together (the comparison under them counts from there); joint: they are playing together; moved: one
// was moved or played on its own since (the next joint play starts counting again); recapture: a jump
// while playing together (a loop), the point is taken again once it lands.
const pair = {loop: null, anchor: null, joint: false, moved: true, recapture: false};
const LOSS = '#ff5c5c', GAIN = '#3fd0c9';
// The video's dots go above everything else on the map, numbered braking pins included.
view.map.createPane('videoNow').style.zIndex = 640;
const clock = s => Math.floor(s / 60) + ':' + (s % 60).toFixed(1).padStart(4, '0').replace('.', ',');
const madrid = ms => new Date(ms).toLocaleString('es-ES', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});
const videoSay = (message, type = '') => say($('videoInfo'), message, type);
const linked = () => current?.data.find(d => d.run.id === clip?.runId) || null;
const linkedB = () => current?.data.find(d => d.run.id === clipB?.runId) || null;
const sayB = (message, type = '') => say($('videoInfoB'), message, type);
const shortLabel = r => (r.mine === false ? r.pilot + ' · ' : '') + when(r.started_at);
const decimal = (x, n = 1) => x.toFixed(n).replace('.', ',');

const runAt = positionAt;
// The run whose time the video covers most: yours first, then your friends'.
function runInVideo(t, accept = () => true) {
  const from = t.lag * 1000, to = (t.lag + t.seconds) * 1000;
  const overlap = r => Math.min(to, Date.parse(r.started_at) + r.elapsed_ms) - Math.max(from, Date.parse(r.started_at));
  return runs.filter(r => r.started_at && overlap(r) > 0 && accept(r))
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
    $('secondVideo').hidden = false;
    $('videoTools').hidden = false;
    renderMarks();
    return videoSay('El vídeo es del ' + madrid(t.lag * 1000) + ' (' + clock(t.seconds) + ') y no tienes ninguna bajada de ese momento. ' +
      'Sube la ruta de tu reloj de ese día, o usa el GPS de la propia GoPro: lo subimos como una ruta de entrenamiento y, si sigue un circuito, aparece la bajada.');
  }
  clip.runId = run.id;
  // A second video of another circuit no longer makes sense.
  if (clipB?.runId && runs.find(r => r.id === clipB.runId)?.circuit_id !== run.circuit_id) dropSecond();
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
  if (clipB?.runId) picked = [run.id, clipB.runId, ...picked.filter(id => id !== run.id && id !== clipB.runId)].slice(0, COLORS.length);
  renderRunList();
  await compare();
  clip.start = Date.parse(run.started_at) / 1000 - t.lag;
  $('secondVideo').hidden = false;
  $('videoTools').hidden = false;
  // The camera's GPS against the run's (the same one when the run came from the camera).
  const d = linked(), started = Date.parse(run.started_at);
  clip.gps = cameraGps(t, clip.start, clip.start + run.elapsed_ms / 1000,
    ms => ms < started || ms > started + run.elapsed_ms ? null : runAt(d.profile, ms - started));
  videoSay('Vídeo de la bajada ' + (run.mine === false ? 'de ' + run.pilot + ' ' : '') + 'del ' + madrid(started) +
    ' en ' + run.circuit_name + ': la salida está en el ' + clock(Math.max(0, clip.start)) + ' del vídeo y la meta en el ' +
    clock(clip.start + run.elapsed_ms / 1000) + '.' + footageNote(clip, d, 'el vídeo') + (clip.gps.ok ? '' : ' El GPS de la cámara iba mal en esta bajada (' +
    (clip.gps.offM > 20 ? 'a unos ' + Math.round(clip.gps.offM) + ' m de la ruta' : 'precisión ' + decimal(clip.gps.dop)) +
    '): la velocidad y las frenadas salen de la ruta, y las paradas, de cómo se mueve la cámara. La hora del vídeo sí es exacta.'),
    clip.gps.ok ? 'success' : 'warning');
  if (video().paused && video().currentTime < 0.1) video().currentTime = Math.max(0, clip.start - 2);
  renderMoments();
  syncVideo();
  if (clipB && !clipB.runId && clipB.telemetry?.good) await linkSecond();
}
// Stops, hard braking, shocks and jumps of the run in the video, from the camera's own sensors.
function renderMoments() {
  const d = linked(), box = $('videoMoments');
  if (!clip || !d) return box.replaceChildren();
  const gps = clip.gps?.ok !== false;
  const all = videoMoments(clip.telemetry, clip.start, clip.start + d.run.elapsed_ms / 1000, {gps});
  const of = kind => all.filter(m => m.kind === kind);
  const still = of('stop').reduce((sum, m) => sum + m.seconds, 0);
  const counts = [
    of('stop').length ? of('stop').length + ' parada(s), ' + decimal(still) + ' s quieto' : 'sin paradas',
    ...gps ? [of('brake').length + ' frenada(s) fuertes'] : [], of('shock').length + ' golpe(s) de 4 g o más',
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
      (still >= 1 ? ' Sin las paradas habrías tardado unos ' + decimal(d.run.elapsed_ms / 1000 - still) + ' s.' : '') +
      (gps ? '' : ' Las frenadas, en «Frenadas»: salen de la ruta, porque el GPS de la cámara no era fiable.')}),
    ...shown.map(m => {
      const at = runAt(d.profile, (m.t - clip.start) * 1000);
      const button = node('button', {type: 'button', className: 'moment moment-' + m.kind}, [
        node('b', {textContent: clock(m.t)}), node('span', {textContent: text(m)}), node('small', {textContent: Math.round(at.s) + ' m'})]);
      button.addEventListener('click', () => {
        video().currentTime = Math.max(0, m.t - 1.5);
        syncVideo();
        $('mapDuo').scrollIntoView({behavior: 'smooth', block: 'nearest'});
      });
      return button;
    }));
}
const video = () => $('video');
// Map point, chart cursor and the line under the video, at the video's current time.
let drawnAt = 0;
function syncVideo() {
  const d = linked(), hud = $('videoHud');
  // While playing, the map, the charts and the lines under the videos are redrawn ten times a second,
  // not on every frame: the videos come first.
  const now = performance.now();
  if (isPlaying() && now - drawnAt < 100) {
    if (d) {repeatStretch(d, (video().currentTime - clip.start) * 1000); moveMarks();}
    return;
  }
  drawnAt = now;
  hudSecond();
  showPairGap();
  if (!clip || !d) {
    hud.textContent = !clip ? '' : clip.telemetry?.good ? 'Vídeo grabado el ' + madrid(clip.telemetry.lag * 1000) + ' · ' + clock(video().currentTime) :
      'Vídeo sin GPS · ' + clock(video().currentTime);
    return;
  }
  const ms = (video().currentTime - clip.start) * 1000;
  // The replay follows the video: every compared run where it was at this moment of the video's run.
  replay.ms = Math.min(replayEnd(), Math.max(0, ms));
  drawReplay();
  repeatStretch(d, ms);
  moveMarks();
  if (ms < 0 || ms > d.run.elapsed_ms) {
    setHud(hud, d, ms < 0 ? 'Antes de la salida: faltan ' + clock(-ms / 1000) : 'Después de la meta · ' + formatMs(d.run.elapsed_ms));
    return;
  }
  const at = runAt(d.profile, ms), speed = speedAt(clip, d, video().currentTime, at.s);
  const ref = current.reference;
  // With a second video the comparison is under both; alone, against the reference run.
  const race = ref !== d && !linkedB() ? ' · ' + formatDelta(ms - timeAt(ref.profile, at.s)) + ' frente a ' + shortLabel(ref.run) : '';
  setHud(hud, d, formatMs(ms) + ' · ' + speedText(speed) + ' · ' + Math.round(at.s) + ' m' + race);
}
// The camera's own speed at this frame (its GPS measures it ten times a second) when it can be trusted,
// else the run's.
function speedAt(c, d, second, metres) {
  const near = c.gps?.ok === false ? {t: Infinity} :
    c.telemetry.points.reduce((best, p) => p.fix >= 2 && Math.abs(p.t - second) < Math.abs(best.t - second) ? p : best, {t: Infinity});
  return Math.abs(near.t - second) < 0.5 ? near.speed * 3.6 : d.speed.kmh[Math.min(d.speed.kmh.length - 1, Math.max(0, Math.round(metres / 10)))];
}
const speedText = speed => speed === null || speed === undefined ? '—' : Math.max(0, Math.round(speed)) + ' km/h';
// The line under a video, with the colour of its run.
function setHud(hud, d, text) {
  const chip = node('i', {className: 'chip'});
  chip.style.background = d.color;
  hud.replaceChildren(chip, text);
}

// ---- A second video next to the first ----
// Each video goes on its own and shows its own run at its own frame. You put them where you want (each
// with its own bar, or both at once on a sector, a braking or a note: each where its run was there) and
// play them together; from there each one runs on, and the line under them says how much one gains on
// the other since that point. Nothing keeps re-aligning them while they play.
// The second video: a file of the device (a <video>), or a YouTube video (its player, made to look like one).
let youtube = null;
const videoB = () => youtube || $('videoB');
const isPlaying = () => {const A = video(); return !A.paused && !A.seeking && A.readyState >= 3;};
const runMs = (c, v) => (v.currentTime - c.start) * 1000;
// Both videos to where each run was at this metre of the circuit (`lead` seconds before it).
function seekBoth(metres, lead = 0) {
  const a = linked(), b = linkedB();
  if (a) video().currentTime = Math.max(0, Math.min(video().duration || Infinity, clip.start + timeAt(a.profile, metres) / 1000 - lead));
  if (clipB?.url && b) {
    const want = clipB.start + timeAt(b.profile, metres) / 1000 - lead, end = videoB().duration || clipB.telemetry?.seconds || Infinity;
    videoB().currentTime = Math.max(0, Math.min(end, want));
    if (want < -0.5 || want > end) toolsHint('El vídeo 2 no tiene imagen en el metro ' + Math.round(metres) + ': su cámara ' +
      (want < 0 ? 'empezó a grabar más tarde.' : 'dejó de grabar antes.'));
  }
}
// Play both from where they are (once both can, so they start together) or pause both.
function ready(v) {
  return v.readyState >= 3 ? Promise.resolve() : new Promise(done => {
    const go = () => {v.removeEventListener('canplay', go); done();};
    v.addEventListener('canplay', go);
    setTimeout(go, 5000);
  });
}
const both = () => [video(), ...(clipB?.url ? [videoB()] : [])];
async function playBoth() {
  const videos = both();
  await Promise.all(videos.map(ready));
  if (pair.moved || !pair.anchor) pair.anchor = clipB?.url && clip ? {msA: runMs(clip, video()), msB: runMs(clipB, videoB())} : null;
  pair.moved = false;
  pair.joint = true;
  // YouTube goes up to ×2: both at the same speed.
  const rate = youtube ? Math.min(replay.speed, 2) : replay.speed;
  videos.forEach(v => {v.playbackRate = rate;});
  if (youtube && videos.includes(youtube)) return playAlong();
  await Promise.all(videos.map(v => v.play().catch(() => {})));
}
const pauseBoth = () => {endAlong(); both().forEach(v => v.pause());};
// With a YouTube video: it takes a moment to start (more than a file) and may stop to load. It goes first,
// video 1 starts where it should be by then, and while both play video 1 keeps the distance they were
// lined up at. Each still shows its own rider: only the two clocks are kept together.
let along = null;
function endAlong() {
  if (!along) return;
  along = null;
  video().playbackRate = replay.speed;
}
async function playAlong() {
  const fromA = video().currentTime, fromB = youtube.currentTime, mine = {fromA, fromB};
  along = mine;
  await youtube.play();
  if (along !== mine) return;
  video().currentTime = fromA + Math.max(0, youtube.currentTime - fromB);
  await video().play().catch(() => {});
}
// A small difference is made up with video 1 a little faster or slower (no jump to see); a big one, when
// YouTube stopped to load, with a jump.
setInterval(() => {
  if (!along || !youtube || video().paused || youtube.paused || video().seeking) return;
  const rate = Math.min(replay.speed, 2);
  const drift = (video().currentTime - along.fromA) - (youtube.currentTime - along.fromB);
  if (Math.abs(drift) > 1) {video().currentTime -= drift; video().playbackRate = rate; return;}
  video().playbackRate = Math.abs(drift) < 0.04 ? rate : rate * (drift > 0 ? 0.92 : 1.08);
}, 250);
// The line under the second video: its own run at its own frame.
function hudSecond() {
  const v = videoB(), b = linkedB(), hud = $('videoHudB');
  if (!clipB?.url) return;
  if (!b) return hud.replaceChildren((youtube ? 'YouTube' : 'Vídeo 2') + ' · ' + clock(v.currentTime));
  const ms = runMs(clipB, v);
  if (ms < 0 || ms > b.run.elapsed_ms)
    return setHud(hud, b, ms < 0 ? 'Antes de la salida: faltan ' + clock(-ms / 1000) : 'Después de la meta · ' + formatMs(b.run.elapsed_ms));
  const here = runAt(b.profile, ms);
  setHud(hud, b, formatMs(ms) + ' · ' + speedText(speedAt(clipB, b, v.currentTime, here.s)) + ' · ' + Math.round(here.s) + ' m');
}
// The line under both videos. While they are being placed: where each one is. Once played together with
// ▶ Reproducir: since that point, how much one gains on the other and how far apart they are. Pausing and
// playing on keeps the point; moving either video, or playing one on its own, takes a new one.
function showPairGap() {
  const box = $('pairGap'), a = linked(), b = linkedB();
  if (!clipB?.url || !a || !b) {box.hidden = true; markLeader(); return;}
  const msA = runMs(clip, video()), msB = runMs(clipB, videoB());
  if (pair.recapture && !video().seeking && !videoB().seeking) {pair.anchor = {msA, msB}; pair.recapture = false;}
  const inA = ms => Math.max(0, Math.min(ms, a.run.elapsed_ms)), inB = ms => Math.max(0, Math.min(ms, b.run.elapsed_ms));
  const here = runAt(a.profile, inA(msA)).s, there = runAt(b.profile, inB(msB)).s;
  box.hidden = false;
  // Being placed (not played together from here yet): where each one is.
  if (pair.moved || !pair.anchor) {
    markLeader();
    const apart = Math.round(Math.abs(there - here));
    box.replaceChildren('Vídeo 1 en el metro ' + Math.round(here) + ', vídeo 2 en el metro ' + Math.round(there) + (apart > 25 ?
      ': no están en el mismo sitio. Llévalos a un mismo punto con sus botones, o pulsa un sector o una frenada.' :
      '. Dale a ▶ Reproducir y verás cuánto le saca uno al otro desde aquí.'));
    return;
  }
  // The same metres from each one's starting point (lined up by eye, the two days' GPS may put that point a
  // few metres apart): how long each took to ride them, and how far apart they are now.
  const fromA = runAt(a.profile, inA(pair.anchor.msA)).s, fromB = runAt(b.profile, inB(pair.anchor.msB)).s, ridden = here - fromA;
  const gained = (timeAt(b.profile, fromB + ridden) - inB(pair.anchor.msB)) - (inA(msA) - inA(pair.anchor.msA));
  const apart = Math.round(Math.abs(ridden - (there - fromB)));
  const chip = d => Object.assign(node('i', {className: 'chip'}), {style: 'background:' + d.color});
  markLeader(Math.abs(gained) < 50 ? null : gained > 0 ? 1 : 2, seconds(Math.abs(gained)));
  const start = fromA < 5 && fromB < 5 ? 'Desde la salida' : Math.abs(fromA - fromB) <= 5 ? 'Desde el metro ' + Math.round(fromA) :
    'Desde donde empezaron (metro ' + Math.round(fromA) + ' y ' + Math.round(fromB) + ')';
  box.replaceChildren(node('span', {textContent: start + ': '}),
    ...(Math.abs(gained) < 50 ? [node('b', {textContent: 'van igual'})] : [chip(gained > 0 ? a : b),
      node('b', {textContent: 'el vídeo ' + (gained > 0 ? '1' : '2') + ' le saca ' + seconds(Math.abs(gained)) + ' al ' + (gained > 0 ? '2' : '1')})]),
    node('span', {textContent: ' · ' + (apart < 1 ? 'a la par' : apart + ' m entre ellos')}));
}
// The video that goes ahead since both were played together gets a green frame, with how much it gains.
function markLeader(lead = null, gain = '') {
  [[$('videoDock'), 1], [$('videoDockB'), 2]].forEach(([dock, which]) => {
    dock.classList.toggle('leading', lead === which);
    dock.dataset.lead = lead === which ? gain : '';
  });
}
// Where a video starts and ends along its run, when the camera was switched on after the start or off
// before the finish ('' when it films the whole run).
function footageNote(c, d, which) {
  const begins = -c.start * 1000, ends = (c.telemetry.seconds - c.start) * 1000, notes = [];
  if (begins > 1000) notes.push('empieza ' + Math.round(begins / 1000) + ' s después de la salida, en el metro ' + Math.round(runAt(d.profile, begins).s) +
    ' (antes no hay imagen)');
  if (ends < d.run.elapsed_ms - 1000) notes.push('acaba antes de la meta, en el metro ' + Math.round(runAt(d.profile, ends).s) + ' (después no hay imagen)');
  return notes.length ? ' Ojo: ' + which + ' ' + notes.join(' y ') + '.' : '';
}
function showSecond() {
  const dock = $('videoDockB');
  // Its own buttons belong to the one shown: the file's player or YouTube's. YouTube's is never moved (it
  // was made first in the dock): an iframe moved in the page loads again and stops saying when it plays.
  dock.querySelector('.own-controls')?.remove();
  $('videoB').hidden = !!youtube;
  dock.append(...(youtube ? [] : [videoB()]), ownControls(videoB(), 'vídeo 2'), $('videoHudB'));
  videoB().hidden = false;
  $('videoDockB').hidden = false;
  $('mapDuo').classList.add('two');
  fitVideo();
}
async function linkSecond() {
  const a = linked(), t = clipB.telemetry;
  const run = a && t?.good ? runInVideo(t, r => r.circuit_id === a.run.circuit_id && r.id !== a.run.id) : null;
  showSecond();
  pair.anchor = null;
  pair.moved = true;
  if (!run) {
    clipB.runId = null;
    $('pairGap').hidden = true;
    markLeader();
    if (youtube) sayB('Vídeo de YouTube' + (youtube.title ? ': «' + youtube.title + '»' : '') + '. YouTube le quita el GPS, así que no tiene ' +
      'tiempo ni velocidad: ponlos los dos en el mismo punto (la salida, o una curva o una piedra que se reconozca) con los botones ' +
      'de cada uno y dale a ▶ Reproducir. Arrancan a la vez y cada uno sigue a su ritmo.' +
      (linked() ? ' El mapa y la información siguen al vídeo 1.' : ''), 'success');
    else sayB((!t ? 'Este vídeo no lleva la telemetría de una GoPro.' : !t.good ? 'Este vídeo no tiene señal GPS.' :
      !a ? 'El vídeo 1 no está enlazado con ninguna bajada.' : 'En este vídeo no hay otra bajada de ' + a.run.circuit_name + ', tuya ni de tus amigos.') +
      ' Puedes verlos juntos igual: ponlos en el mismo punto con sus barras y dale a ▶.', 'warning');
    hudSecond();
    return;
  }
  clipB.runId = run.id;
  picked = [a.run.id, run.id, ...picked.filter(id => id !== a.run.id && id !== run.id)].slice(0, COLORS.length);
  renderRunList();
  await compare();
  clipB.start = Date.parse(run.started_at) / 1000 - t.lag;
  const b = linkedB(), started = Date.parse(run.started_at);
  clipB.gps = cameraGps(t, clipB.start, clipB.start + run.elapsed_ms / 1000,
    ms => ms < started || ms > started + run.elapsed_ms ? null : runAt(b.profile, ms - started));
  const diff = run.elapsed_ms - a.run.elapsed_ms, note = footageNote(clipB, b, 'el vídeo 2');
  sayB('Vídeo 2: la bajada ' + (run.mine === false ? 'de ' + run.pilot + ' ' : '') + 'del ' + madrid(started) + ', ' + formatMs(run.elapsed_ms) +
    ' (' + formatDelta(diff) + ' frente al vídeo 1). Dale a ▶, o llévalos a la vez a un sector o una frenada con la barra de debajo del vídeo 1.' +
    note, note ? 'warning' : 'success');
  // Both where both have footage: at the start, or where the later camera began recording.
  const begins = (c, d) => c.start < 0 ? runAt(d.profile, -c.start * 1000 + 500).s : 0, first = Math.max(begins(clip, a), begins(clipB, b));
  pauseBoth();
  seekBoth(first, first ? 0 : 2);
  if (first) toolsHint('Están los dos en el metro ' + Math.round(first) + ', donde empieza la imagen de los dos.');
  syncVideo();
}
function dropYoutube() {
  if (!youtube) return;
  endAlong();
  youtube.destroy();
  youtube = null;
}
function dropSecond() {
  dropYoutube();
  videoB().pause();
  if (clipB?.url) URL.revokeObjectURL(clipB.url);
  videoB().removeAttribute('src');
  videoB().load();
  clipB = null;
  pair.anchor = null;
  pair.moved = true;
  $('videoDockB').hidden = true;
  $('pairGap').hidden = true;
  markLeader();
  $('mapDuo').classList.remove('two');
  $('videoNameB').textContent = 'Otra bajada del mismo circuito: tuya de otro día o de un amigo que te pase su vídeo';
  fitVideo();
}
// The telemetry of a GoPro, or null for any other MP4 (still fine to watch next to another).
async function readTelemetry(file) {
  try {return await readGoproTelemetry(file);}
  catch {return null;}
}
$('videoFileB').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  $('videoNameB').textContent = file.name + ' · ' + (file.size / 1e9).toFixed(1).replace('.', ',') + ' GB';
  sayB('Leyendo la telemetría de ' + file.name + '…');
  try {
    const telemetry = await readTelemetry(file);
    dropYoutube();
    if (clipB?.url) URL.revokeObjectURL(clipB.url);
    clipB = {file, name: file.name, telemetry, url: URL.createObjectURL(file), runId: null, start: 0};
    videoB().src = clipB.url;
    await linkSecond();
    $('mapDuo').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (err) {sayB('No se puede usar este vídeo: ' + err.message, 'error');}
});
// A YouTube video instead of a file: its link, and the same place and buttons as a file.
$('youtubeForm').addEventListener('submit', async event => {
  event.preventDefault();
  const link = youtubeLink($('youtubeUrl').value);
  if (!link) return sayB('Eso no es el enlace de un vídeo de YouTube. En YouTube: Compartir → Copiar enlace, y pégalo aquí.', 'error');
  sayB('Cargando el vídeo de YouTube…');
  const holder = node('div', {className: 'yt-frame'}), dock = $('videoDockB'), was = dock.hidden;
  // The player is made in the page, where it will be seen.
  dock.prepend(holder);
  dock.hidden = false;
  $('mapDuo').classList.add('two');
  try {
    const next = await YouTubeVideo.create(link, holder);
    dropYoutube();
    if (clipB?.url && !clipB.youtube) {$('videoB').pause(); URL.revokeObjectURL(clipB.url); $('videoB').removeAttribute('src'); $('videoB').load();}
    youtube = next;
    listenSecond(youtube);
    clipB = {youtube: link.id, name: youtube.title || 'YouTube', telemetry: null, url: 'https://youtu.be/' + link.id, runId: null, start: 0};
    $('videoNameB').textContent = 'YouTube · ' + (youtube.title || link.id);
    $('youtubeUrl').value = '';
    await linkSecond();
    $('mapDuo').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (err) {
    holder.remove();
    if (!clipB) {dock.hidden = was; $('mapDuo').classList.remove('two'); fitVideo();}
    sayB('No se puede usar ese vídeo de YouTube: ' + err.message, 'error');
  }
});
// Each video plays and pauses on its own (only ▶ Reproducir plays both); moving one, or playing it on
// its own, starts counting again at the next joint play.
function listenSecond(v) {
  v.addEventListener('loadedmetadata', () => {fitVideo(); syncVideo();});
  v.addEventListener('play', () => {if (!pair.joint) pair.moved = true; ownLabel(videoB());});
  // A pause of the second one does not end playing together: the browser itself pauses a muted video for a
  // moment at times (out of view, or short of data) and plays it on.
  v.addEventListener('pause', () => {if (v === youtube) endAlong(); ownLabel(videoB());});
  v.addEventListener('seeking', movedOrJumped);
  v.addEventListener('timeupdate', () => {hudSecond(); showPairGap(); if (video().paused) drawReplay();});
  v.addEventListener('error', () => {
    if (clipB) sayB(v === youtube ? youtube.error : 'Este navegador no puede mostrar el segundo vídeo (H.265). Prueba con Safari, o con Chrome o Edge al día.', 'error');
  });
}
listenSecond($('videoB'));

// ---- Beeps: the same one when a video's run goes through the start and the finish, a softer one at each
// sector gate. Each video beeps at its own run's gates, only when it plays through them (not when moved).
const BEEPS_KEY = 'dhtrails.beeps';
let beeps = true;
try {beeps = localStorage.getItem(BEEPS_KEY) !== 'off';} catch {}
const gateTimes = new WeakMap();
function gatesOfRun(d) {
  if (!gateTimes.has(d)) gateTimes.set(d, runGates(gatesOf(current.circuit).map(m => timeAt(d.profile, m)), d.run.elapsed_ms));
  return gateTimes.get(d);
}
// A video moved to a gate lands on a frame, a frame or two past it at most.
const ON_GATE_MS = 80;
function beepAtGates(v, clipOf, runOf) {
  // last: the run's moment at the previous check while playing; rung: the gate that sounded last (so it
  // does not sound twice when the video is paused just past it and played on).
  let last = null, rung = null;
  const check = () => {
    const c = clipOf(), d = runOf();
    if (!beeps || !c || !d || v.paused || v.seeking) {last = null; return;}
    const ms = runMs(c, v);
    // Checked on every frame; at ×4 the steps are longer.
    gatesPassed(last, ms, gatesOfRun(d), 3000 * Math.max(1, v.playbackRate)).filter(g => g !== rung).forEach(g => {beep(g.kind); rung = g;});
    last = ms;
  };
  const step = () => {if (v.paused) return; check(); v.requestVideoFrameCallback ? v.requestVideoFrameCallback(step) : requestAnimationFrame(step);};
  // Played from on a gate (a sector of the bar under the video takes it there), it beeps as it starts.
  v.addEventListener('play', () => {const c = clipOf(); last = c && !v.seeking ? runMs(c, v) - ON_GATE_MS : null; step();});
  v.addEventListener('seeking', () => {last = null; rung = null;});
  v.addEventListener('timeupdate', check);
}
beepAtGates(video(), () => clip, linked);
beepAtGates(videoB(), () => clipB, linkedB);
// The browser only lets the page make sound after a tap: any tap with a video loaded gets it ready.
['pointerdown', 'keydown'].forEach(type => document.addEventListener(type, () => {if (beeps && clip) unlockSound();}, {passive: true}));
const showBeeps = () => {
  $('beepToggle').setAttribute('aria-pressed', String(beeps));
  $('beepToggle').textContent = (beeps ? '🔊' : '🔇') + ' Pitidos';
};
$('beepToggle').addEventListener('click', () => {
  beeps = !beeps;
  try {localStorage.setItem(BEEPS_KEY, beeps ? 'on' : 'off');} catch {}
  showBeeps();
  if (beeps) beep('line');
});
showBeeps();

// ---- Tools to look closely: each video's own buttons, and one stretch over and over ----
const toolsHint = (text = '') => {$('toolsHint').textContent = text;};
// Under each video: a second or a tenth back and forward, and play or pause, for that video alone: to
// stop one on a frame (a tree, a rock) and find that same moment in the other.
function ownControls(v, which) {
  const button = (text, label, action) => {
    const b = node('button', {type: 'button', textContent: text, title: label, ariaLabel: label + ' (' + which + ')'});
    b.addEventListener('click', action);
    return b;
  };
  const move = seconds => () => {
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + seconds));
  };
  const play = button('▶', 'Reproducir o parar solo este vídeo', () => {v.playbackRate = replay.speed; v.paused ? v.play().catch(() => {}) : v.pause();});
  play.className = 'own-play';
  return node('div', {className: 'own-controls'}, [button('−1s', 'Un segundo atrás', move(-1)), button('−0,1', 'Una décima atrás', move(-0.1)),
    play, button('+0,1', 'Una décima adelante', move(0.1)), button('+1s', 'Un segundo adelante', move(1))]);
}
const ownLabel = v => {const b = v.parentElement?.querySelector('.own-play'); if (b) b.textContent = v.paused ? '▶' : '❚❚';};
// Moving a video by hand starts counting again; a jump while both play together (a loop) keeps
// counting from where it lands.
function movedOrJumped() {
  if (pair.joint) pair.recapture = true;
  else pair.moved = true;
}
// The stretch chosen on the map: a sector of the table, a braking or a stretch where time is lost.
function selectedStretch() {
  if (!current || !mapSelection) return null;
  if (mapSelection.kind === 'zone') return {from: mapSelection.from, to: mapSelection.to};
  if (mapSelection.kind !== 'segment') return null;
  const c = current.circuit, d = distanceSeries(c.points), bounds = [0, ...c.sectors.map(s => s.index), c.points.length - 1];
  return {from: d[bounds[mapSelection.index]], to: d[bounds[mapSelection.index + 1]]};
}
function setLoop(stretch) {
  pair.loop = stretch;
  $('loopStretch').setAttribute('aria-pressed', String(!!stretch));
  toolsHint(stretch ? 'Repitiendo de ' + Math.round(stretch.from) + ' a ' + Math.round(stretch.to) + ' m' : '');
}
$('loopStretch').addEventListener('click', () => {
  const d = linked();
  if (!d) return toolsHint('Carga antes un vídeo con su bajada.');
  if (pair.loop) return setLoop(null);
  const stretch = selectedStretch();
  if (!stretch) return toolsHint('Elige antes un tramo: un sector de la tabla, una frenada o un tramo donde pierdes.');
  setLoop(stretch);
  seekBoth(stretch.from, 1.5);
  playBoth();
});
// Past the end of the stretch (and a little more), back to a second and a half before it.
function repeatStretch(d, ms) {
  if (!pair.loop || video().paused || video().seeking) return;
  if (ms > d.run.elapsed_ms || runAt(d.profile, ms).s >= pair.loop.to + 5) seekBoth(pair.loop.from, 1.5);
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
  seekBoth(metres);
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
    const second = clipB?.runId === d.run.id && !!clipB.url, video = clip?.runId === d.run.id;
    const t = Math.max(0, Math.min(second ? runMs(clipB, videoB()) : ms, d.run.elapsed_ms)), at = runAt(d.profile, t);
    // The video's run with a yellow ring, like the charts' cursor; the second video's with a blue one;
    // the others with a white one.
    const style = {radius: video || second ? 10 : 8, color: video ? HIGHLIGHT : second ? '#5fd4ff' : '#ffffff', weight: video || second ? 4 : 3,
      fillColor: d.color, fillOpacity: 1, interactive: false, pane: 'videoNow'};
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
  // With a video loaded (with a run or not) the button plays the video; else the replay.
  const running = clip?.url ? !video().paused : replay.playing;
  $('replayPlay').textContent = running ? '❚❚ Pausa' : '▶ Reproducir';
};
$('replayPlay').addEventListener('click', () => {
  if (clip?.url) return video().paused ? playBoth() : pauseBoth();
  if (!current?.data.length) return status('Elige primero las bajadas que quieres ver.', 'error');
  if (replay.playing) return stopReplay();
  if (replay.ms >= replayEnd()) replay.ms = 0;
  replay.playing = true;
  replay.last = performance.now();
  playButton();
  replay.frame = requestAnimationFrame(tick);
});
document.querySelectorAll('.replay-speeds button[data-speed]').forEach(b => b.addEventListener('click', () => {
  replay.speed = Number(b.dataset.speed);
  document.querySelectorAll('.replay-speeds button[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  if (clip?.url) both().forEach(v => {v.playbackRate = replay.speed;});
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
    const telemetry = await readTelemetry(file);
    if (clip?.url) URL.revokeObjectURL(clip.url);
    clip = {file, name: file.name, telemetry, url: URL.createObjectURL(file), runId: null, start: 0};
    $('videoTag').textContent = (telemetry?.camera || 'VÍDEO').toUpperCase();
    video().src = clip.url;
    $('videoBox').hidden = false;
    dockVideo();
    if (telemetry?.good) await linkVideo();
    else {
      clip.runId = null;
      $('secondVideo').hidden = false;
      $('videoTools').hidden = false;
      $('videoMoments').replaceChildren();
      renderMarks();
      videoSay((telemetry ? 'Este vídeo no tiene señal GPS' : 'Este vídeo no lleva la telemetría de una GoPro') +
        ': no se puede enlazar con una bajada. Puedes verlo y compararlo con otro sincronizándolos a mano.', 'warning');
      syncVideo();
    }
    $('mapDuo').scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (err) {videoSay('No se puede usar este vídeo: ' + err.message, 'error');}
});
// The video goes next to the map, both sized to be seen at once without scrolling: a vertical video
// beside it as tall as fits on the screen; a horizontal one beside it on a wide screen, and above it
// on a phone.
function dockVideo() {
  const dock = $('videoDock');
  dock.append(video(), dock.querySelector('.own-controls') || ownControls(video(), 'vídeo 1'), $('videoMarks'), $('videoHud'));
  $('videoDock').hidden = false;
  $('mapDuo').classList.add('with-video');
  fitVideo();
}
let fittedWidth = 0;
function fitVideo() {
  const duo = $('mapDuo'), v = video();
  if (!duo.classList.contains('with-video')) return;
  fittedWidth = window.innerWidth;
  const shape = el => el.videoWidth && el.videoHeight ? el.videoWidth / el.videoHeight : 16 / 9;
  const ratio = shape(v), two = duo.classList.contains('two'), other = two ? shape(videoB()) : 0, width = duo.clientWidth, hud = 36;
  // Room below for the replay bar and the video tools.
  const phone = width < 700, height = Math.max(phone ? 260 : 340, Math.min(phone ? 560 : 860, window.innerHeight - 215));
  // Two videos: beside the map when they are vertical on a wide screen; else both on top, the map below.
  const stacked = two ? phone || (ratio > 1 && other > 1) : phone && ratio > 1;
  let dock, dock2 = 0, map;
  if (two) {
    const tall = stacked ? Math.min(height * 0.62 - hud, width / (ratio + other)) : Math.min(height - hud, width * 0.66 / (ratio + other));
    [dock, dock2] = [tall * ratio, tall * other];
    map = stacked ? Math.max(220, height - tall - hud) : height;
  } else if (stacked) {dock = width; map = Math.max(200, height - width / ratio - hud);}
  else {
    dock = Math.min((height - hud) * ratio, width * (ratio > 1 ? 0.55 : 0.5));
    // On a phone the map is only as tall as the video beside it, so the replay below still fits.
    map = phone ? Math.max(300, dock / ratio + hud) : height;
  }
  duo.classList.toggle('stacked', stacked);
  duo.classList.toggle('narrow', !stacked && width - dock - dock2 < 320);
  duo.style.setProperty('--dock-w', Math.round(dock) + 'px');
  duo.style.setProperty('--dock-w2', Math.round(dock2) + 'px');
  duo.style.setProperty('--map-h', Math.round(map) + 'px');
  view.map.invalidateSize();
}
video().addEventListener('loadedmetadata', fitVideo);
video().addEventListener('timeupdate', syncVideo);
video().addEventListener('seeked', syncVideo);
// Smooth while playing, frame by frame where the browser allows it.
video().addEventListener('pause', () => {
  endAlong();
  pair.joint = false;
  ownLabel(video());
  playButton();
});
video().addEventListener('seeking', movedOrJumped);
video().addEventListener('play', () => {
  if (!pair.joint) pair.moved = true;
  ownLabel(video());
  playButton();
  const step = () => {if (video().paused) return; syncVideo(); video().requestVideoFrameCallback ? video().requestVideoFrameCallback(step) : requestAnimationFrame(step);};
  step();
});
// GoPro films in H.265: not every browser can show it. The map and the charts still follow the time.
video().addEventListener('error', () => videoSay('Este navegador no puede mostrar el vídeo (la GoPro graba en H.265). Prueba con Safari, ' +
  'o con Chrome o Edge al día, o con el archivo .LRV de la tarjeta, más ligero. La telemetría sí se ha leído.', 'error'));

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // Only a new width: on a phone, scrolling hides and shows the address bar and changes the height.
    if (window.innerWidth !== fittedWidth) fitVideo();
    compare().catch(() => {});
  }, 250);
});

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
  await receiveShared();
}
// A route shared from another app on the phone: ready to upload with one tap, here or to an open
// time trial.
async function receiveShared() {
  const shared = await takeShared($('routeFile'));
  if (!shared) return;
  // Under the upload button: the page's own status line is soon taken by the comparison.
  const box = shell.me ? $('found') : $('needLogin').querySelector('.panel-content');
  if (shared.missing) return box.prepend(node('p', {className: 'status error', textContent:
    'No ha llegado ningún archivo. Vuelve a compartirlo, o elígelo con «Importar GPX / TCX».'}));
  const open = shell.me ? (await shell.api.tournaments().catch(() => [])).filter(t => t.state === 'activo') : [];
  box.prepend(node('p', {className: 'status success', textContent: 'Has compartido ' + shared.file.name + '. ' + (shell.me ?
    'Pulsa «Buscar circuitos» para subirla a tus entrenamientos' + (open.length ? ', o envíala al time trial:' : '.') :
    'Entra con tu cuenta para subirla.')}),
    ...open.slice(0, 1).map(t => node('a', {className: 'btn outline small', href: './index.html?compartido', textContent: 'Enviar al time trial «' + t.name + '»'})));
  (shell.me ? $('analyze') : box).scrollIntoView({behavior: 'smooth', block: 'center'});
}
start().catch(err => status('Error: ' + err.message, 'error'));
