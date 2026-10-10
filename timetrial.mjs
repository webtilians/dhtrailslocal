// DH Trails v0.8 — Time trial: tournament standings and run upload, for everyone.
import {compareSectorTimes, formatMs, formatDelta} from './sector-comparison.mjs';
import {sectorLabels, standingsRows, idealMs, asAttempt} from './competition-core.mjs';
import {$, node, say, startShell, createMap, drawCircuit, km, dateText} from './app-shell.mjs';

const view = createMap('map');
let shell = null, tournaments = [], board = null;
const status = (message, type = '') => say($('status'), message, type);
const account = (message, type = '') => {const el = $('account'); el.hidden = !message; say(el, message, type);};
const STATE = {activo: 'EN CURSO', proximo: 'PRÓXIMO', terminado: 'TERMINADO'};
const selected = () => tournaments.find(t => t.id === $('tournamentSelect').value) || null;

function paint(comparison = null) {
  view.clear();
  if (!board) return;
  const pts = drawCircuit(view, board.circuit, {fit: !comparison});
  if (!comparison) return;
  const colors = {faster: '#1ddd93', slower: '#ff6275', equal: '#85caff', unknown: '#9facc0'};
  for (const s of comparison.sectors)
    view.add(L.polyline(pts.slice(s.from, s.to + 1), {color: colors[s.status], weight: 9, opacity: .95}))
      .bindTooltip('Segmento ' + (s.index + 1) + ' · ' + formatDelta(s.deltaMs), {sticky: true, direction: 'top'});
}

function renderStandings() {
  const out = $('standings'), rows = standingsRows(board);
  out.replaceChildren();
  $('statRiders').textContent = board ? String(rows.length) : '—';
  $('statBest').textContent = rows.length ? formatMs(rows[0].elapsed_ms) : '—';
  $('statIdeal').textContent = formatMs(idealMs(board));
  if (!board) return out.append(node('p', {className: 'board-empty', textContent: 'No hay ningún torneo todavía.'}));
  if (!rows.length) return out.append(node('p', {className: 'board-empty', textContent: 'Todavía no hay tiempos en este torneo. Sube tu bajada y sé el primero.'}));
  const circuit = board.circuit, labels = sectorLabels(circuit);
  const head = node('tr', {}, ['Pos', 'Piloto', 'Tiempo', 'Dif.', ...labels.map(l => l.short)].map((text, i) =>
    node('th', {textContent: text, title: i > 3 ? labels[i - 4].long : ''})));
  const body = node('tbody');
  for (const row of rows) {
    const tr = node('tr', {tabIndex: 0, title: 'Ver en el mapa dónde gana o pierde tiempo frente al líder'}, [
      node('td', {className: 'pos', textContent: String(row.rank)}),
      node('td', {textContent: row.pilot}),
      node('td', {className: 'time', textContent: formatMs(row.elapsed_ms)}),
      node('td', {className: row.gap_ms === 0 ? 'lead' : 'gap', textContent: row.gapText}),
      ...row.sectors.map((s, i) => node('td', {className: s.best ? 'best' : '', textContent: formatMs(s.ms),
        title: labels[i].long + (s.best ? ' · mejor parcial' : '')}))]);
    const pick = () => {
      body.querySelectorAll('tr').forEach(r => r.classList.toggle('selected', r === tr));
      const leader = rows[0];
      if (row.entry_id === leader.entry_id) {paint(); return status(row.pilot + ' lidera con ' + formatMs(row.elapsed_ms) + '.', 'success');}
      try {
        const comparison = compareSectorTimes(circuit, asAttempt(leader, circuit.id), asAttempt(row, circuit.id));
        paint(comparison);
        const worst = comparison.sectors.filter(s => s.deltaMs !== null).sort((a, b) => b.deltaMs - a.deltaMs)[0];
        status(row.pilot + ' frente a ' + leader.pilot + ': ' + formatDelta(comparison.totalDeltaMs) +
          (worst && worst.deltaMs > 0 ? '. Donde más pierde: segmento ' + (worst.index + 1) + ' (' + formatDelta(worst.deltaMs) + ').' : '.'), 'success');
      } catch (err) {status(err.message, 'error');}
    };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', e => {if (e.key === 'Enter' || e.key === ' ') {e.preventDefault(); pick();}});
    body.append(tr);
  }
  out.append(node('table', {className: 'standings'}, [node('thead', {}, [head]), body]));
}

async function loadBoard() {
  const t = selected();
  board = t ? await shell.api.tournament(t.id) : null;
  $('tState').textContent = t ? STATE[t.state] : '';
  $('boardTag').textContent = t ? t.circuit_name.toUpperCase() : '—';
  $('tInfo').textContent = t ? t.circuit_name + ' · ' + km(board.circuit.length_m) + ' · ' + (board.circuit.sectors.length + 1) +
    ' segmentos · del ' + dateText(t.starts_on) + ' al ' + dateText(t.ends_on) + ' · coincidencia mínima ' + Math.round(t.min_match * 100) + ' %' :
    'La organización todavía no ha creado ningún torneo.';
  paint();
  renderStandings();
  await refreshMine();
}

function entryBox(e) {
  const inside = e.review_status === 'approved';
  const box = node('div', {className: 'attempt'}, [
    node('div', {className: 'attempt-head'}, [
      node('div', {}, [node('div', {className: 'caps', textContent: dateText(e.started_at) + ' · coincide ' + Math.round((e.match || 0) * 100) + ' %'}),
        node('strong', {textContent: formatMs(e.elapsed_ms)})]),
      node('span', {className: 'badge ' + (inside ? 'ok' : 'bad'), textContent: inside ? 'En la clasificación' : 'No entra'})])]);
  if (!inside && e.review_note) box.append(node('div', {className: 'issue', textContent: e.review_note}));
  if (e.notes) box.append(node('div', {className: 'note', textContent: e.notes}));
  box.append(node('div', {className: 'splits'}, e.sector_splits_ms.map((ms, i) =>
    node('div', {className: 'split'}, [node('span', {textContent: 'Segmento ' + (i + 1)}), node('b', {textContent: formatMs(ms)})]))));
  return box;
}

async function refreshMine() {
  const t = selected();
  if (!t || !shell.me) return;
  const entries = await shell.api.myEntries(t.id);
  $('myEntries').replaceChildren(...(entries.length ? entries.map(e => node('div', {className: 'item'}, [
    node('span', {textContent: dateText(e.started_at) + ' · ' + formatMs(e.elapsed_ms) + (e.review_note && e.review_status !== 'approved' ? ' · ' + e.review_note : '')}),
    node('span', {className: 'badge ' + (e.review_status === 'approved' ? 'ok' : 'bad'), textContent: e.review_status === 'approved' ? 'Dentro' : 'Fuera'})])) :
    [node('p', {className: 'placeholder', textContent: 'Todavía no has enviado bajadas a este torneo.'})]));
}

function reflectUser() {
  const me = shell.me, t = selected();
  $('needLogin').hidden = !!me;
  $('needName').hidden = !me || !!me.display_name;
  $('uploadBox').hidden = !me || !me.display_name;
  const open = t && t.state !== 'proximo';
  $('submitEntry').disabled = !open;
  if (me && t && !open) account('El torneo empieza el ' + dateText(t.starts_on) + '.');
}

$('loginButton').addEventListener('click', () => shell.askLogin('Entra o crea tu cuenta para participar.'));
$('tournamentSelect').addEventListener('change', () => loadBoard().then(reflectUser).catch(err => status(err.message, 'error')));
$('saveName').addEventListener('click', async () => {
  try {shell.setUser({...shell.me, ...await shell.api.setDisplayName($('displayName').value)}); account('');}
  catch (err) {account('No se pudo guardar el nombre: ' + err.message, 'error');}
});
$('entryFile').addEventListener('change', e => {
  const file = e.target.files[0];
  $('entryFileName').textContent = file ? file.name + ' · ' + Math.round(file.size / 1024) + ' KB' : 'GPX / TCX del día de la bajada';
});
$('submitEntry').addEventListener('click', async () => {
  const t = selected(), file = $('entryFile').files[0];
  if (!t) return account('No hay ningún torneo abierto.', 'error');
  if (!file) return account('Elige el archivo GPX o TCX de tu bajada.', 'error');
  const btn = $('submitEntry');
  btn.disabled = true;
  account('Buscando tu bajada en ' + t.circuit_name + '…');
  try {
    const entry = await shell.api.submitEntry(t.id, file);
    $('entryResult').replaceChildren(entryBox(entry));
    account(entry.review_status === 'approved' ? 'Bajada aceptada: ' + formatMs(entry.elapsed_ms) + '. Ya estás en la clasificación.' :
      'La bajada no entra en la clasificación: ' + (entry.review_note || 'no pasa el filtro') + '.', entry.review_status === 'approved' ? 'success' : 'error');
    $('entryFile').value = ''; $('entryFileName').textContent = 'GPX / TCX del día de la bajada';
    await loadBoard();
  } catch (err) {account('No se ha aceptado la bajada: ' + err.message, 'error');}
  finally {btn.disabled = false; reflectUser();}
});

async function start() {
  shell = await startShell('timetrial');
  if (!shell.api) {
    $('tInfo').textContent = 'El time trial funciona desde el servidor de DH Trails: abre esta página en su dirección.';
    return;
  }
  shell.onUser(() => {reflectUser(); refreshMine().catch(() => {});});
  tournaments = await shell.api.tournaments();
  $('tournamentSelect').replaceChildren(...(tournaments.length ? tournaments.map(t => node('option', {value: t.id,
    textContent: t.name + ' · ' + t.circuit_name + (t.state === 'activo' ? ' · en curso' : t.state === 'proximo' ? ' · próximo' : '')})) :
    [node('option', {value: '', textContent: 'No hay torneos todavía'})]));
  await loadBoard();
  reflectUser();
  view.map.invalidateSize();
}
start().catch(err => status('Error: ' + err.message, 'error'));
