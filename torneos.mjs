// DH Trails v0.8 — Torneos (organization): create a time trial on a saved circuit and review its runs.
import {formatMs} from './sector-comparison.mjs';
import {$, node, say, startShell, km, dateText} from './app-shell.mjs';
import {distanceSeries} from './gps-engine.mjs';

let shell = null, tournaments = [], selected = null;
const status = (message, type = '') => say($('status'), message, type);
const STATE = {activo: ['En curso', 'ok'], proximo: ['Próximo', ''], terminado: ['Terminado', 'muted']};
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const ENTRY = {approved: ['En la clasificación', 'ok'], pending: ['En revisión', ''], rejected: ['Rechazada', 'bad']};

// The form filled for a whole calendar month (this one by default).
function defaults(month = new Date()) {
  $('tName').value = 'Torneo de ' + MONTHS[month.getMonth()] + ' ' + month.getFullYear();
  $('tStart').value = iso(new Date(month.getFullYear(), month.getMonth(), 1));
  $('tEnd').value = iso(new Date(month.getFullYear(), month.getMonth() + 1, 0));
}
// The next month's tournament after this one, on the same circuit until another is chosen.
function prepareNext(t) {
  const end = new Date(t.ends_on + 'T00:00:00');
  defaults(new Date(end.getFullYear(), end.getMonth() + 1, 1));
  if ([...$('tCircuit').options].some(o => o.value === t.circuit_id)) $('tCircuit').value = t.circuit_id;
  say($('createFeedback'), 'Formulario listo para el mes siguiente: elige el circuito del mes y pulsa «Crear torneo».', 'success');
  $('newTournament').scrollIntoView({behavior: 'smooth', block: 'start'});
  $('tCircuit').focus();
}

async function loadCircuits() {
  // Only approved circuits go into a tournament (riders' ones wait in Circuitos for an organizer).
  const circuits = (await shell.api.listCircuits()).filter(c => c.approved);
  $('tCircuit').replaceChildren(...(circuits.length ? circuits.map(c => node('option', {value: c.id,
    textContent: c.name + ' · ' + km(distanceSeries(c.points).at(-1)) + ' · ' + (c.sectors.length + 1) + ' segmentos'})) :
    [node('option', {value: '', textContent: 'Primero guarda o aprueba un circuito en la pestaña Circuitos'})]));
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
    const next = node('button', {type: 'button', className: 'text-btn', textContent: 'Preparar el siguiente'});
    next.addEventListener('click', () => prepareNext(t));
    return node('div', {className: 'item' + (selected?.id === t.id ? ' selected' : '')}, [
      node('span', {}, [node('b', {textContent: t.name}),
        node('small', {textContent: ' · ' + t.circuit_name + ' · del ' + dateText(t.starts_on) + ' al ' + dateText(t.ends_on) +
          ' · mínimo ' + Math.round(t.min_match * 100) + ' % · ' + t.riders + ' piloto(s) en la clasificación'})]),
      node('span', {className: 'row-actions'}, [node('span', {className: 'badge ' + tone, textContent: label}),
        ...(t.pending ? [node('span', {className: 'badge', textContent: t.pending + ' por revisar'})] : []), open, next, remove])]);
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
  const rows = entries.flatMap(e => {
    const decide = (decision, text) => {
      const b = node('button', {type: 'button', className: 'btn outline small', textContent: text});
      b.addEventListener('click', async () => {
        const note = decision === 'rejected' ? window.prompt('Motivo del rechazo (lo verá el piloto):', '') : '';
        if (note === null) return;
        try {await shell.api.reviewEntry(e.id, decision, note); await openTournament(t);}
        catch (err) {status(err.message, 'error');}
      });
      return b;
    };
    const [label, tone] = ENTRY[e.review_status] || ENTRY.rejected;
    const actions = e.review_status === 'pending' ? [decide('approved', 'Aceptar'), decide('rejected', 'Rechazar')] :
      [e.review_status === 'approved' ? decide('rejected', 'Rechazar') : decide('approved', 'Aceptar')];
    const file = node('button', {type: 'button', className: 'text-btn', textContent: 'GPX'});
    file.addEventListener('click', async () => {
      try {
        const url = URL.createObjectURL(await shell.api.entryFile(e.id));
        const a = node('a', {href: url, download: e.source_filename || 'bajada.gpx'});
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      } catch (err) {status(err.message, 'error');}
    });
    // Why it is out or under review, and what looked edited or copied (for the organization only: the
    // rider sees «En revisión»), on a row of its own that stays in view on a phone.
    const details = [
      ...(e.review_note ? [node('small', {className: 'reason', textContent: e.review_note})] : []),
      ...(e.checks?.length ? [node('ul', {className: 'checks'}, e.checks.map(c => node('li', {textContent: c})))] : []),
      ...(e.reviewed_by_hand ? [node('small', {className: 'reason by-hand', textContent: 'Decidido a mano por la organización'})] : [])];
    return [node('tr', {className: details.length ? 'has-detail' : ''}, [
      node('td', {textContent: e.pilot || 'Piloto'}),
      node('td', {className: 'time', textContent: formatMs(e.elapsed_ms)}),
      node('td', {textContent: e.match === null ? '—' : Math.round(e.match * 100) + ' %'}),
      node('td', {}, [node('span', {className: 'badge ' + tone, textContent: label})]),
      node('td', {className: 'row-actions'}, [...actions, file])]),
      ...(details.length ? [node('tr', {className: 'entry-detail'}, [node('td', {colSpan: 5}, [node('div', {}, details)])])] : [])];
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
