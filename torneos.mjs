// DH Trails v0.8 — Torneos (organization): create a time trial on a saved circuit and review its runs.
import {formatMs} from './sector-comparison.mjs';
import {$, node, say, startShell, km, dateText} from './app-shell.mjs';
import {distanceSeries} from './gps-engine.mjs';

let shell = null, tournaments = [], selected = null;
const status = (message, type = '') => say($('status'), message, type);
const STATE = {activo: ['En curso', 'ok'], proximo: ['Próximo', ''], terminado: ['Terminado', 'muted']};
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function defaults() {
  const now = new Date();
  $('tName').value = 'Torneo de ' + MONTHS[now.getMonth()] + ' ' + now.getFullYear();
  $('tStart').value = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  $('tEnd').value = iso(new Date(now.getFullYear(), now.getMonth() + 1, 0));
}

async function loadCircuits() {
  const circuits = await shell.api.listCircuits();
  $('tCircuit').replaceChildren(...(circuits.length ? circuits.map(c => node('option', {value: c.id,
    textContent: c.name + ' · ' + km(distanceSeries(c.points).at(-1)) + ' · ' + (c.sectors.length + 1) + ' segmentos'})) :
    [node('option', {value: '', textContent: 'Primero guarda un circuito en la pestaña Circuitos'})]));
}

async function loadTournaments() {
  tournaments = await shell.api.tournaments();
  $('tCount').textContent = tournaments.length ? tournaments.length + ' EN TOTAL' : '';
  $('tList').replaceChildren(...(tournaments.length ? tournaments.map(t => {
    const [label, tone] = STATE[t.state];
    const open = node('button', {type: 'button', className: 'btn outline small', textContent: 'Ver bajadas'});
    open.addEventListener('click', () => openTournament(t));
    const remove = node('button', {type: 'button', className: 'text-btn danger', textContent: 'Borrar'});
    remove.addEventListener('click', () => removeTournament(t));
    return node('div', {className: 'item' + (selected?.id === t.id ? ' selected' : '')}, [
      node('span', {}, [node('b', {textContent: t.name}),
        node('small', {textContent: ' · ' + t.circuit_name + ' · del ' + dateText(t.starts_on) + ' al ' + dateText(t.ends_on) +
          ' · mínimo ' + Math.round(t.min_match * 100) + ' % · ' + t.riders + ' piloto(s) en la clasificación'})]),
      node('span', {className: 'row-actions'}, [node('span', {className: 'badge ' + tone, textContent: label}), open, remove])]);
  }) : [node('p', {className: 'placeholder', textContent: 'Todavía no hay torneos.'})]));
}

async function removeTournament(t) {
  if (!window.confirm('¿Borrar el torneo «' + t.name + '»? Solo se puede si nadie ha subido bajadas.')) return;
  try {
    await shell.api.deleteTournament(t.id);
    if (selected?.id === t.id) {selected = null; $('entriesPanel').hidden = true;}
    await loadTournaments(); await loadCircuits();
    status('Torneo borrado.', 'success');
  } catch (err) {status('No se pudo borrar: ' + err.message, 'error');}
}

async function openTournament(t) {
  selected = t;
  $('entriesPanel').hidden = false;
  $('entriesTitle').textContent = t.name;
  const entries = await shell.api.tournamentEntries(t.id);
  $('entriesCount').textContent = entries.length + ' BAJADA(S)';
  await loadTournaments();
  if (!entries.length) return $('entries').replaceChildren(node('p', {className: 'placeholder', textContent: 'Nadie ha subido bajadas todavía.'}));
  const head = node('tr', {}, ['Piloto', 'Tiempo', 'Coincidencia', 'Estado', ''].map(text => node('th', {textContent: text})));
  const rows = entries.map(e => {
    const accepted = e.review_status === 'approved';
    const flip = node('button', {type: 'button', className: 'btn outline small', textContent: accepted ? 'Rechazar' : 'Aceptar'});
    flip.addEventListener('click', async () => {
      const note = accepted ? window.prompt('Motivo del rechazo (lo verá el piloto):', '') : '';
      if (note === null) return;
      try {await shell.api.reviewEntry(e.id, accepted ? 'rejected' : 'approved', note); await openTournament(t);}
      catch (err) {status(err.message, 'error');}
    });
    const file = node('button', {type: 'button', className: 'text-btn', textContent: 'GPX'});
    file.addEventListener('click', async () => {
      try {
        const url = URL.createObjectURL(await shell.api.entryFile(e.id));
        const a = node('a', {href: url, download: e.source_filename || 'bajada.gpx'});
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {status(err.message, 'error');}
    });
    return node('tr', {}, [
      node('td', {textContent: e.pilot || 'Piloto'}),
      node('td', {className: 'time', textContent: formatMs(e.elapsed_ms)}),
      node('td', {textContent: e.match === null ? '—' : Math.round(e.match * 100) + ' %'}),
      node('td', {}, [node('span', {className: 'badge ' + (accepted ? 'ok' : 'bad'), textContent: accepted ? 'En la clasificación' : 'Rechazada'}),
        ...(e.review_note ? [node('small', {className: 'reason', textContent: e.review_note})] : [])]),
      node('td', {className: 'row-actions'}, [flip, file])]);
  });
  $('entries').replaceChildren(node('table', {className: 'standings'}, [node('thead', {}, [head]), node('tbody', {}, rows)]));
}

$('newTournament').addEventListener('submit', async event => {
  event.preventDefault();
  if (!$('tCircuit').value) return say($('createFeedback'), 'Primero guarda un circuito en la pestaña Circuitos.', 'error');
  try {
    const t = await shell.api.createTournament({name: $('tName').value, circuit_id: $('tCircuit').value,
      starts_on: $('tStart').value, ends_on: $('tEnd').value, min_match: Number($('tMatch').value) / 100});
    say($('createFeedback'), 'Torneo «' + t.name + '» creado. Ya aparece en Time trial.', 'success');
    await loadTournaments(); await loadCircuits();
  } catch (err) {say($('createFeedback'), 'No se pudo crear: ' + err.message, 'error');}
});

async function start() {
  defaults();
  shell = await startShell('torneos');
  const allowed = () => {
    const ok = !!shell.me?.organizer;
    $('workspace').hidden = !ok;
    $('notAllowed').hidden = ok;
    if (!ok && shell.api && !shell.me) shell.askLogin('Entra con tu cuenta de organizador para crear torneos.');
    return ok;
  };
  shell.onUser(() => {if (allowed()) Promise.all([loadCircuits(), loadTournaments()]).catch(err => status(err.message, 'error'));});
  if (!shell.api) {$('workspace').hidden = true; $('notAllowed').hidden = false; return;}
  if (allowed()) await Promise.all([loadCircuits(), loadTournaments()]);
}
start().catch(err => status('Error: ' + err.message, 'error'));
