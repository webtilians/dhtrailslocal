// DH Trails v0.8 — Time trial: tournament standings and run upload, for everyone.
import {compareSectorTimes, formatMs, formatDelta} from './sector-comparison.mjs';
import {sectorLabels, standingsRows, idealMs, asAttempt} from './competition-core.mjs';
import {podiumImage} from './podium-image.mjs';
import {$, node, say, startShell, takeShared, createMap, drawCircuit, km, dateText} from './app-shell.mjs';
import {T, tServer} from './i18n.mjs';

const view = createMap('map');
let shell = null, tournaments = [], board = null;
const status = (message, type = '') => say($('status'), message, type);
const account = (message, type = '') => {const el = $('account'); el.hidden = !message; say(el, message, type);};
const STATE = {activo: T('EN CURSO'), proximo: T('PRÓXIMO'), terminado: T('TERMINADO')};
const selected = () => tournaments.find(t => t.id === $('tournamentSelect').value) || null;
// An entry is in the standings, waiting for the organization (it looked edited or copied) or out.
const ENTRY = {approved: [T('En la clasificación'), 'ok', T('Dentro')], pending: [T('En revisión'), '', T('En revisión')],
  rejected: [T('No entra'), 'bad', T('Fuera')]};
const entryState = e => ENTRY[e.review_status] || ENTRY.rejected;
// Whole days from today to the end of that calendar day (0 on the day itself).
const daysUntil = iso => Math.round((new Date(iso + 'T00:00:00') - new Date(new Date().toDateString())) / 86400000);
const VERIFIED = T('Verificado: el archivo no muestra señales de estar editado o copiado, o la organización lo ha revisado.');

function paint(comparison = null) {
  view.clear();
  if (!board) return;
  const pts = drawCircuit(view, board.circuit, {fit: !comparison});
  if (!comparison) return;
  const colors = {faster: '#1ddd93', slower: '#ff6275', equal: '#85caff', unknown: '#9facc0'};
  for (const s of comparison.sectors)
    view.add(L.polyline(pts.slice(s.from, s.to + 1), {color: colors[s.status], weight: 9, opacity: .95}))
      .bindTooltip(T('Segmento {n}', {n: s.index + 1}) + ' · ' + formatDelta(s.deltaMs), {sticky: true, direction: 'top'});
}

function renderStandings() {
  const out = $('standings'), rows = standingsRows(board);
  out.replaceChildren();
  $('statRiders').textContent = board ? String(rows.length) : '—';
  $('statBest').textContent = rows.length ? formatMs(rows[0].elapsed_ms) : '—';
  $('statIdeal').textContent = formatMs(idealMs(board));
  if (!board) return out.append(node('p', {className: 'board-empty', textContent: T('No hay ningún torneo todavía.')}));
  if (!rows.length) return out.append(node('p', {className: 'board-empty', textContent: T('Todavía no hay tiempos en este torneo. Sube tu bajada y sé el primero.')}));
  const circuit = board.circuit, labels = sectorLabels(circuit);
  const head = node('tr', {}, [T('Pos'), T('Piloto'), T('Tiempo'), T('Dif.'), ...labels.map(l => l.short)].map((text, i) =>
    node('th', {textContent: text, title: i > 3 ? labels[i - 4].long : ''})));
  const body = node('tbody');
  for (const row of rows) {
    const tr = node('tr', {tabIndex: 0, title: T('Ver en el mapa dónde gana o pierde tiempo frente al líder')}, [
      node('td', {className: 'pos', textContent: String(row.rank)}),
      node('td', {}, [row.pilot, ...(row.verified ? [node('span', {className: 'tick', textContent: ' ✓', title: VERIFIED})] : [])]),
      node('td', {className: 'time', textContent: formatMs(row.elapsed_ms)}),
      node('td', {className: row.gap_ms === 0 ? 'lead' : 'gap', textContent: row.gapText}),
      ...row.sectors.map((s, i) => node('td', {className: s.best ? 'best' : '', textContent: formatMs(s.ms),
        title: labels[i].long + (s.best ? ' · ' + T('mejor parcial') : '')}))]);
    const pick = () => {
      body.querySelectorAll('tr').forEach(r => r.classList.toggle('selected', r === tr));
      const leader = rows[0];
      if (row.entry_id === leader.entry_id) {paint(); return status(T('{name} lidera con {time}.', {name: row.pilot, time: formatMs(row.elapsed_ms)}), 'success');}
      try {
        const comparison = compareSectorTimes(circuit, asAttempt(leader, circuit.id), asAttempt(row, circuit.id));
        paint(comparison);
        const worst = comparison.sectors.filter(s => s.deltaMs !== null).sort((a, b) => b.deltaMs - a.deltaMs)[0];
        status(T('{name} frente a {leader}: {delta}', {name: row.pilot, leader: leader.pilot, delta: formatDelta(comparison.totalDeltaMs)}) +
          (worst && worst.deltaMs > 0 ? T('. Donde más pierde: segmento {n} ({delta}).', {n: worst.index + 1, delta: formatDelta(worst.deltaMs)}) : '.'), 'success');
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
  $('tInfo').textContent = t ? t.circuit_name + ' · ' + km(board.circuit.length_m) + ' · ' +
    T('{n} segmentos · del {from} al {to} · coincidencia mínima {match} %', {n: board.circuit.sectors.length + 1,
      from: dateText(t.starts_on), to: dateText(t.ends_on), match: Math.round(t.min_match * 100)}) :
    T('La organización todavía no ha creado ningún torneo.');
  paint();
  renderStandings();
  renderResult();
  await refreshMine();
}

// While it runs: how long is left. Once over: the podium, final when nobody can upload any more and
// the organization has reviewed every entry, with a picture to share.
function renderResult() {
  const t = board?.tournament, panel = $('resultPanel');
  panel.hidden = !t || t.state === 'proximo';
  if (panel.hidden) return;
  const rows = standingsRows(board), out = $('result');
  if (t.state === 'activo') {
    const left = daysUntil(t.ends_on);
    $('resultTitle').textContent = T('En curso');
    $('resultTag').textContent = left === 0 ? T('ÚLTIMO DÍA') : left === 1 ? T('QUEDA 1 DÍA') : T('QUEDAN {n} DÍAS', {n: left});
    return out.replaceChildren(node('p', {className: 'help result-note', textContent:
      T('Cierra el {end}; las bajadas de esos días se pueden subir hasta el {until}.', {end: dateText(t.ends_on), until: dateText(t.uploads_until)}) + ' ' +
      (rows.length ? T('Va primero {name} con {time}.', {name: rows[0].pilot, time: formatMs(rows[0].elapsed_ms)}) : T('Todavía no hay tiempos.'))}));
  }
  $('resultTitle').textContent = board.final ? T('Podio final') : T('Resultado provisional');
  $('resultTag').textContent = T('TERMINÓ EL {date}', {date: dateText(t.ends_on).toUpperCase()});
  const why = board.final ? [] : [
    ...(board.pending ? [T('La organización tiene {n} bajada(s) por revisar.', {n: board.pending})] : []),
    ...(daysUntil(t.uploads_until) >= 0 ? [T('Aún se pueden subir bajadas de esos días hasta el {date}.', {date: dateText(t.uploads_until)})] : [])];
  if (!rows.length) return out.replaceChildren(node('p', {className: 'help result-note', textContent: T('Nadie tiene tiempo en este torneo.')}));
  const winner = rows[0];
  const podium = node('div', {className: 'podium'}, rows.slice(0, 3).map((row, i) => node('div', {className: 'podium-step place-' + (i + 1)}, [
    node('b', {className: 'podium-rank', textContent: String(row.rank)}),
    node('span', {className: 'podium-who'}, [node('strong', {textContent: row.pilot}),
      node('small', {className: row.verified ? 'verified' : '', textContent: row.verified ? '✓ ' + T('Verificado') : T('Sin verificar'),
        title: row.verified ? VERIFIED : T('La organización todavía no ha comprobado esta bajada.')})]),
    node('span', {className: 'podium-time'}, [node('strong', {textContent: formatMs(row.elapsed_ms)}),
      node('small', {textContent: i ? row.gapText : T('Mejor tiempo')})])])));
  const share = node('button', {type: 'button', className: 'btn outline', textContent: T('Imagen para compartir')});
  share.addEventListener('click', () => sharePodium(rows).catch(err => status(T('No se pudo crear la imagen: {error}', {error: err.message}), 'error')));
  const wins = {name: winner.pilot, time: formatMs(winner.elapsed_ms)};
  out.replaceChildren(
    node('p', {className: 'result-note', textContent: (board.final ? T('Gana {name} con {time}', wins) : T('De momento gana {name} con {time}', wins)) +
      (winner.verified ? T(', verificado.') : '.') + (why.length ? ' ' + why.join(' ') : '')}),
    podium, share);
}

// The podium as a PNG: shared straight away from a phone, downloaded on a computer.
async function sharePodium(rows) {
  const blob = await podiumImage({tournament: board.tournament, circuit: board.circuit, rows, final: board.final, site: location.host});
  const file = new File([blob], T('podio') + '-' + board.tournament.name.toLowerCase().replace(/[^a-z0-9]+/gi, '-') + '.png', {type: 'image/png'});
  if (navigator.canShare?.({files: [file]})) {
    try {return await navigator.share({files: [file], title: board.tournament.name});}
    catch (err) {if (err.name === 'AbortError') return;}
  }
  const url = URL.createObjectURL(file);
  const a = node('a', {href: url, download: file.name});
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  status(T('Imagen del podio descargada: {file}.', {file: file.name}), 'success');
}

function entryBox(e) {
  const [label, tone] = entryState(e);
  const box = node('div', {className: 'attempt'}, [
    node('div', {className: 'attempt-head'}, [
      node('div', {}, [node('div', {className: 'caps', textContent: dateText(e.started_at) + ' · ' + T('coincide {n} %', {n: Math.round((e.match || 0) * 100)})}),
        node('strong', {textContent: formatMs(e.elapsed_ms)})]),
      node('span', {className: 'badge ' + tone, textContent: label})])]);
  if (e.review_status === 'pending')
    box.append(node('div', {className: 'issue', textContent: T('La organización la revisará antes de que entre en la clasificación.')}));
  else if (e.review_status !== 'approved' && e.review_note) box.append(node('div', {className: 'issue', textContent: tServer(e.review_note)}));
  if (e.notes) box.append(node('div', {className: 'note', textContent: tServer(e.notes)}));
  box.append(node('div', {className: 'splits'}, e.sector_splits_ms.map((ms, i) =>
    node('div', {className: 'split'}, [node('span', {textContent: T('Segmento {n}', {n: i + 1})}), node('b', {textContent: formatMs(ms)})]))));
  return box;
}

async function refreshMine() {
  const t = selected();
  if (!t || !shell.me) return;
  const entries = await shell.api.myEntries(t.id);
  $('myEntries').replaceChildren(...(entries.length ? entries.map(e => node('div', {className: 'item'}, [
    node('span', {textContent: dateText(e.started_at) + ' · ' + formatMs(e.elapsed_ms) + (e.review_note && e.review_status === 'rejected' ? ' · ' + tServer(e.review_note) : '')}),
    node('span', {className: 'badge ' + entryState(e)[1], textContent: entryState(e)[2]})])) :
    [node('p', {className: 'placeholder', textContent: T('Todavía no has enviado bajadas a este torneo.')})]));
}

function reflectUser() {
  const me = shell.me, t = selected();
  $('needLogin').hidden = !!me;
  $('needName').hidden = !me || !!me.display_name;
  $('uploadBox').hidden = !me || !me.display_name;
  const open = t && t.state !== 'proximo';
  $('submitEntry').disabled = !open;
  if (me && t && !open) account(T('El torneo empieza el {date}.', {date: dateText(t.starts_on)}));
}

$('loginButton').addEventListener('click', () => shell.askLogin(T('Entra o crea tu cuenta para participar.')));
$('tournamentSelect').addEventListener('change', () => loadBoard().then(reflectUser).catch(err => status(err.message, 'error')));
$('saveName').addEventListener('click', async () => {
  try {shell.setUser({...shell.me, ...await shell.api.setDisplayName($('displayName').value)}); account('');}
  catch (err) {account(T('No se pudo guardar el nombre: {error}', {error: err.message}), 'error');}
});
$('entryFile').addEventListener('change', e => {
  const file = e.target.files[0];
  $('entryFileName').textContent = file ? file.name + ' · ' + Math.round(file.size / 1024) + ' KB' : T('GPX / TCX del día de la bajada');
});
$('submitEntry').addEventListener('click', async () => {
  const t = selected(), file = $('entryFile').files[0];
  if (!t) return account(T('No hay ningún torneo abierto.'), 'error');
  if (!file) return account(T('Elige el archivo GPX o TCX de tu bajada.'), 'error');
  const btn = $('submitEntry');
  btn.disabled = true;
  account(T('Buscando tu bajada en {circuit}…', {circuit: t.circuit_name}));
  try {
    const entry = await shell.api.submitEntry(t.id, file);
    $('entryResult').replaceChildren(entryBox(entry));
    const time = formatMs(entry.elapsed_ms);
    account(entry.review_status === 'approved' ? T('Bajada aceptada: {time}. Ya estás en la clasificación.', {time}) :
      entry.review_status === 'pending' ? T('Bajada recibida: {time}. La organización la revisará antes de que entre en la clasificación.', {time}) :
      T('La bajada no entra en la clasificación: {why}.', {why: entry.review_note ? tServer(entry.review_note) : T('no pasa el filtro')}),
      {approved: 'success', pending: '', rejected: 'error'}[entry.review_status]);
    $('entryFile').value = ''; $('entryFileName').textContent = T('GPX / TCX del día de la bajada');
    await loadBoard();
  } catch (err) {account(T('No se ha aceptado la bajada: {error}', {error: err.message}), 'error');}
  finally {btn.disabled = false; reflectUser();}
});

async function start() {
  shell = await startShell('timetrial');
  if (!shell.api) {
    $('tInfo').textContent = T('El time trial funciona desde el servidor de DH Trails: abre esta página en su dirección.');
    return;
  }
  shell.onUser(() => {reflectUser(); refreshMine().catch(() => {});});
  tournaments = await shell.api.tournaments();
  $('tournamentSelect').replaceChildren(...(tournaments.length ? tournaments.map(t => node('option', {value: t.id,
    textContent: t.name + ' · ' + t.circuit_name + (t.state === 'activo' ? ' · ' + T('en curso') : t.state === 'proximo' ? ' · ' + T('próximo') : '')})) :
    [node('option', {value: '', textContent: T('No hay torneos todavía')})]));
  await loadBoard();
  reflectUser();
  view.map.invalidateSize();
  // A route shared from another app on the phone, sent on here from the training page.
  const shared = await takeShared($('entryFile'));
  if (shared?.file) account(T('Has compartido {file}. Comprueba el torneo y pulsa «Enviar al time trial».', {file: shared.file.name}));
  else if (shared?.missing) account(T('No ha llegado ningún archivo: elígelo con «Sube tu bajada».'), 'error');
  if (shared) $('submitEntry').scrollIntoView({behavior: 'smooth', block: 'center'});
}
start().catch(err => status('Error: ' + err.message, 'error'));
