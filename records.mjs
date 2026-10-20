// DH Trails v0.8 — Récords: every rider's best time on each circuit, and who holds its hot seat.
import {formatMs, formatDelta} from './sector-comparison.mjs';
import {sectorLabels} from './competition-core.mjs';
import {$, node, say, startShell, dateText} from './app-shell.mjs';

let shell = null, friends = false, seats = [], selected = null;
const status = (message, type = '') => say($('status'), message, type);
const place = r => r.rank + 'º';
// How long the hot seat has been held, from the day of the run that set it.
function heldFor(day) {
  const days = Math.floor((Date.now() - new Date(day + 'T12:00:00').getTime()) / 86400000);
  return days <= 0 ? 'desde hoy' : days === 1 ? 'desde ayer' : 'desde el ' + dateText(day) + ' (' + days + ' días)';
}

async function loadSeats() {
  const data = await shell.api.records({friends});
  seats = data.circuits;
  showVisible(data.visible);
  const taken = seats.filter(c => c.hot_seat).length;
  $('seatCount').textContent = taken + ' DE ' + seats.length;
  $('seats').replaceChildren(...(seats.length ? seats.map(c => {
    const b = node('button', {type: 'button', className: 'seat'}, [
      node('b', {textContent: c.name}),
      node('small', {textContent: c.riders ? c.riders + (c.riders === 1 ? ' piloto' : ' pilotos') : ''}),
      node('span', {className: 'holder', textContent: c.hot_seat ? '🔥 ' + c.hot_seat.pilot + ' · ' + formatMs(c.hot_seat.elapsed_ms) :
        friends ? 'Ni tú ni tus amigos tenéis tiempo aquí' : 'Nadie todavía: el hot seat está libre'}),
      ...(c.me && c.me.rank > 1 ? [node('small', {className: 'me', textContent: 'Tú: ' + place(c.me) + ', a ' + formatDelta(c.me.gap_ms)})] :
        c.me ? [node('small', {className: 'me', textContent: '¡Es tuyo!'})] : [])]);
    b.dataset.id = c.id;
    b.addEventListener('click', () => select(c.id).catch(err => status(err.message, 'error')));
    return b;
  }) : [node('p', {className: 'placeholder', textContent: 'Todavía no hay circuitos.'})]));
  const wanted = seats.find(c => c.id === (selected || location.hash.slice(1))) || seats.find(c => c.riders) || seats[0];
  if (wanted) await select(wanted.id);
}

async function select(id) {
  selected = id;
  history.replaceState(null, '', '#' + id);
  $('seats').querySelectorAll('.seat').forEach(b => b.setAttribute('aria-current', String(b.dataset.id === id)));
  const data = await shell.api.circuitRecords(id, {friends});
  const {circuit, rows} = data, labels = sectorLabels(circuit);
  $('boardTitle').textContent = circuit.name;
  $('boardTag').textContent = rows.length ? rows.length + (rows.length === 1 ? ' PILOTO' : ' PILOTOS') : '';
  const first = rows[0], me = rows.find(r => r.mine);
  $('hotSeat').hidden = !first;
  if (first) $('hotSeat').replaceChildren(node('span', {className: 'flame-tag', textContent: '🔥 HOT SEAT'}),
    node('span', {className: 'who', textContent: first.pilot}), node('span', {className: 'time', textContent: formatMs(first.elapsed_ms)}),
    node('small', {textContent: heldFor(first.day) + (rows[1]?.gap_ms > 0 ? ' · le saca ' + formatDelta(rows[1].gap_ms).replace('+', '') + ' a ' + rows[1].pilot : '')}));
  $('myPlace').hidden = !rows.length;
  $('myPlace').textContent = !data.visible ? 'No sales en las clasificaciones: lo has elegido a la izquierda.' :
    me ? (me.rank === 1 ? 'Estás en el hot seat. ' : 'Vas ' + place(me) + ' de ' + rows.length + ', a ' + formatDelta(me.gap_ms) + ' del hot seat. ') +
      'Tu mejor: ' + formatMs(me.elapsed_ms) + ' (' + dateText(me.day) + ').' :
    'Aún no tienes tiempo aquí: sube en Entrenamiento una ruta que pase por ' + circuit.name + '.';
  if (!rows.length) {
    $('board').replaceChildren(node('p', {className: 'board-empty', textContent: friends ?
      'Ni tú ni tus amigos tenéis todavía un tiempo en este circuito.' :
      'Nadie tiene todavía un tiempo en este circuito. Sube en Entrenamiento una ruta que pase por él y ocupa el hot seat.'}));
  } else {
    const head = node('tr', {}, ['Pos', 'Piloto', 'Tiempo', 'Dif.', 'Día', 'Bajadas'].map(text => node('th', {textContent: text, className: text === 'Bajadas' ? 'runs' : ''})));
    $('board').replaceChildren(node('table', {className: 'standings records'}, [node('thead', {}, [head]), node('tbody', {}, rows.map(r =>
      node('tr', {className: r.mine ? 'mine' : ''}, [
        node('td', {className: 'pos', textContent: String(r.rank)}),
        node('td', {}, [r.pilot, ...(r === first ? [node('span', {className: 'hot', textContent: '🔥 HOT SEAT'})] : []),
          ...(r.tournament ? [node('span', {className: 'from-tt', textContent: ' torneo', title: 'Este tiempo es de una bajada de un torneo'})] : [])]),
        node('td', {className: 'time', textContent: formatMs(r.elapsed_ms)}),
        node('td', {className: r.gap_ms === 0 ? 'lead' : 'gap', textContent: r.gap_ms === 0 ? '—' : formatDelta(r.gap_ms)}),
        node('td', {textContent: dateText(r.day)}),
        node('td', {className: 'runs', textContent: String(r.runs)})])))]));
  }
  // Who has the best time of each sector, in any run.
  const kings = data.best_sectors.map((s, i) => s && node('span', {className: s.mine ? 'mine' : '', title: labels[i]?.long || ''},
    [node('b', {textContent: labels[i]?.short || 'S' + (i + 1)}), ' ' + s.pilot + ' · ' + formatMs(s.elapsed_ms)])).filter(Boolean);
  $('sectorKings').hidden = !kings.length;
  $('sectorKings').replaceChildren(node('small', {textContent: 'Mejor de cada sector:'}), ...kings);
  // Runs that look edited or copied: the organization sees whose and why.
  const out = data.not_counted;
  $('notCounted').hidden = !out.length;
  $('notCounted').replaceChildren(...(out.length ? [
    node('p', {className: 'help', textContent: shell.me?.organizer ? 'No cuentan (el archivo parece editado o copiado):' :
      'Estas bajadas tuyas no cuentan: el archivo parece editado o copiado. Si es un error, habla con la organización.'}),
    ...out.map(r => node('div', {className: 'item'}, [node('span', {}, [node('b', {textContent: (r.mine ? 'Tú' : r.pilot) + ' · ' + formatMs(r.elapsed_ms)}),
      node('small', {textContent: ' · ' + dateText(r.day)}),
      ...(r.reasons ? [node('ul', {className: 'checks'}, r.reasons.map(text => node('li', {textContent: text})))] : [])])]))] : []));
}

function showVisible(visible) {
  $('visible').checked = visible;
  $('visibleHelp').textContent = visible ?
    'Los demás ven tu nombre y tu mejor tiempo en cada circuito (nunca tus rutas). Quítalo si prefieres no salir.' :
    'No sales: nadie ve tus tiempos aquí. Tú sí ves las clasificaciones.';
}
$('visible').addEventListener('change', async e => {
  try {
    await shell.api.showInRecords(e.target.checked);
    await loadSeats();
    status(e.target.checked ? 'Ya sales en las clasificaciones.' : 'Ya no sales en las clasificaciones.', 'success');
  } catch (err) {e.target.checked = !e.target.checked; status(err.message, 'error');}
});
document.querySelectorAll('.seg-toggle button').forEach(b => b.addEventListener('click', () => {
  friends = b.dataset.friends === 'true';
  document.querySelectorAll('.seg-toggle button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  loadSeats().catch(err => status(err.message, 'error'));
}));

async function start() {
  shell = await startShell('records');
  const allowed = () => {
    const ok = !!shell.me;
    $('workspace').hidden = !ok;
    $('notAllowed').hidden = ok;
    if (!ok && shell.api) shell.askLogin('Entra con tu cuenta para ver los récords de los circuitos.');
    return ok;
  };
  shell.onUser(() => {if (allowed()) loadSeats().catch(err => status(err.message, 'error'));});
  if (!shell.api) {$('workspace').hidden = true; $('notAllowed').hidden = false; return;}
  if (allowed()) await loadSeats();
}
start().catch(err => status('Error: ' + err.message, 'error'));
