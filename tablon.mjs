// DH Trails — the board (tablón): your and your friends' training, and every rider's time trials, hot seats
// and new circuits, newest first, with 🔥 and comments. Comments can be reported and riders blocked; the
// organization sees the reported ones here (backend: app/feed.py).
import {formatMs, formatDelta} from './sector-comparison.mjs';
import {$, node, say, startShell, dateText} from './app-shell.mjs';
import {T, locale, ordinal} from './i18n.mjs';

let shell = null, next = null, posts = [];
const status = (message, type = '') => {$('status').hidden = !message; say($('status'), message, type);};
const cards = new Map();   // post key → its card on the page

// "5 minutes ago", "yesterday", or the date.
const words = new Intl.RelativeTimeFormat(locale, {numeric: 'auto'});
function ago(iso) {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return T('ahora');
  if (minutes < 60) return words.format(-minutes, 'minute');
  if (minutes < 24 * 60) return words.format(-Math.floor(minutes / 60), 'hour');
  if (minutes < 7 * 24 * 60) return words.format(-Math.floor(minutes / 1440), 'day');
  return dateText(iso);
}
// A delta without its sign: "1.2 s".
const by = ms => formatDelta(ms).replace(/^[+−]/, '');
const AVATAR_COLORS = ['#1f6fb2', '#2a8a5f', '#9a4fb5', '#b8632a', '#b23a52', '#357f8f', '#7a6a1f'];
const avatarColor = id => AVATAR_COLORS[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

// ---- What each post says

function story(p) {
  const circuit = p.circuit || T('un circuito');
  if (p.kind === 'train') {
    const before = p.previous_best_ms;
    return {
      what: (p.mine ? T('Has entrenado en {circuit}', {circuit}) : T('Ha entrenado en {circuit}', {circuit})) + ' · ' +
        (p.runs === 1 ? T('1 bajada') : T('{n} bajadas', {n: p.runs})) + ' · ' + dateText(p.day),
      label: T('Mejor bajada del día'),
      badge: p.personal_best ? {text: '🏆 ' + (p.mine ? T('Tu mejor tiempo aquí') : T('Su mejor tiempo aquí')) + ' · ' + formatDelta(p.elapsed_ms - before), good: true} :
        p.first ? {text: T('Primera vez en este circuito'), good: true} :
        {text: p.mine ? T('A {delta} de tu mejor', {delta: by(p.elapsed_ms - before)}) : T('A {delta} de su mejor', {delta: by(p.elapsed_ms - before)})},
      link: {href: './entrenamiento.html?bajada=' + encodeURIComponent(p.run_id), text: T('Compararla en Entrenamiento')},
    };
  }
  if (p.kind === 'entry') {
    const place = {place: ordinal(p.rank), n: p.riders};
    return {
      what: p.mine ? T('Has bajado en el time trial «{name}»', {name: p.tournament.name}) : T('Ha bajado en el time trial «{name}»', {name: p.tournament.name}),
      label: circuit,
      badge: p.its_best ? {text: (p.rank === 1 ? '🥇 ' : '') + T('{place} de {n}', place), good: p.rank <= 3} :
        {text: p.mine ? T('No mejora tu tiempo: sigues {place} de {n}', place) : T('No mejora su tiempo: sigue {place} de {n}', place)},
      link: {href: './index.html#' + encodeURIComponent(p.tournament.id), text: T('Ver la clasificación')},
    };
  }
  if (p.kind === 'seat') {
    const before = p.previous;
    return {
      what: (p.mine ? T('Ocupas el hot seat de {circuit}', {circuit}) : T('Ocupa el hot seat de {circuit}', {circuit})) +
        (p.tournament ? ' · ' + T('en un time trial') : ''),
      label: '🔥 HOT SEAT',
      badge: !before ? {text: T('Es el primer tiempo del circuito')} :
        before.same ? {text: p.mine ? T('Bajas tu propio récord en {delta}', {delta: by(before.elapsed_ms - p.elapsed_ms)}) :
          T('Baja su propio récord en {delta}', {delta: by(before.elapsed_ms - p.elapsed_ms)}), good: true} :
        {text: p.mine ? T('Se lo quitas a {name} por {delta}', {name: before.pilot, delta: by(before.elapsed_ms - p.elapsed_ms)}) :
          T('Se lo quita a {name} por {delta}', {name: before.pilot, delta: by(before.elapsed_ms - p.elapsed_ms)}), good: true},
      link: {href: './records.html#' + encodeURIComponent(p.circuit_id), text: T('Ver los récords')},
    };
  }
  return {
    what: p.approved ? T('Nuevo circuito para los time trials: {circuit}', {circuit}) :
      p.mine ? T('Has dibujado el circuito {circuit}', {circuit}) : T('Ha dibujado el circuito {circuit}', {circuit}),
    link: {href: './records.html#' + encodeURIComponent(p.circuit_id), text: T('Ver los récords')},
  };
}

// ---- A post's card

function card(p) {
  const s = story(p);
  const head = node('header', {className: 'post-head'}, [
    Object.assign(node('span', {className: 'avatar', textContent: (p.pilot.trim()[0] || '?').toUpperCase(), ariaHidden: 'true'}),
      {style: 'background:' + avatarColor(p.pilot_id)}),
    node('div', {className: 'who'}, [node('b', {textContent: p.pilot}), node('small', {textContent: ago(p.at)})])]);
  if (!p.mine) {
    const block = node('button', {type: 'button', className: 'text-btn', textContent: T('Bloquear a {name}', {name: p.pilot})});
    block.addEventListener('click', () => blockRider(p.pilot_id, p.pilot));
    head.append(node('details', {className: 'post-more'}, [node('summary', {textContent: '⋯', title: T('Más opciones')}), block]));
  }
  const body = [node('p', {className: 'post-what', textContent: s.what})];
  if (p.elapsed_ms != null) body.push(node('div', {className: 'post-time'}, [
    node('small', {textContent: s.label}), node('strong', {textContent: formatMs(p.elapsed_ms)}),
    ...(s.badge ? [node('span', {className: 'badge' + (s.badge.good ? ' ok' : ''), textContent: s.badge.text})] : [])]));
  body.push(node('a', {className: 'post-link', href: s.link.href, textContent: s.link.text + ' →'}));

  // 🔥: whoever sees the post can leave one, and take it back.
  const r = p.reactions;
  const fire = node('button', {type: 'button', className: 'fire', textContent: '🔥 ' + (r.count || ''),
    title: r.mine ? T('Quitar tu 🔥') : T('Dejar un 🔥')});
  fire.setAttribute('aria-pressed', String(r.mine));
  fire.addEventListener('click', async () => {
    fire.disabled = true;
    try {p.reactions = await shell.api.react(p.key); redraw(p);}
    catch (err) {fire.disabled = false; status(err.message, 'error');}
  });
  const names = r.names.length > 3 ? T('{names} y {n} más', {names: r.names.slice(0, 3).join(', '), n: r.names.length - 3}) : r.names.join(', ');
  // The box to comment opens when asked for, and stays open once used.
  const talk = node('button', {type: 'button', className: 'talk', textContent: '💬 ' + (p.comments.length || ''), title: T('Comentar')});
  const actions = node('footer', {className: 'post-actions'}, [fire, talk, node('small', {textContent: names})]);

  const comments = node('div', {className: 'comments'}, p.comments.map(c => comment(p, c)));
  const input = node('input', {maxLength: 300, placeholder: T('Escribe un comentario…'), autocomplete: 'off',
    ariaLabel: T('Escribe un comentario…')});
  const send = node('button', {type: 'submit', className: 'btn outline small', textContent: T('Enviar')});
  const form = node('form', {className: 'comment-form', hidden: !p.talking}, [input, send]);
  talk.addEventListener('click', () => {p.talking = true; form.hidden = false; input.focus();});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send.disabled = true;
    try {
      p.comments.push(await shell.api.addComment(p.key, text));
      redraw(p);
      cards.get(p.key).querySelector('.comment-form input').focus();
    } catch (err) {send.disabled = false; status(err.message, 'error');}
  });
  return node('article', {className: 'post panel kind-' + p.kind}, [head, ...body, actions, comments, form]);
}

function comment(p, c) {
  const tools = [];
  const tool = (text, fn) => {
    const b = node('button', {type: 'button', className: 'text-btn', textContent: text});
    b.addEventListener('click', fn);
    tools.push(' · ', b);
  };
  if (c.can_delete) tool(T('Borrar'), async () => {
    if (!window.confirm(T('¿Borrar este comentario?'))) return;
    try {await shell.api.deleteComment(c.id); p.comments = p.comments.filter(x => x !== c); redraw(p);}
    catch (err) {status(err.message, 'error');}
  });
  if (!c.mine) {
    tool(T('Denunciar'), async () => {
      if (!window.confirm(T('¿Denunciar este comentario a la organización? Dejarás de verlo.'))) return;
      try {
        await shell.api.reportComment(c.id);
        p.comments = p.comments.filter(x => x !== c);
        redraw(p);
        status(T('Gracias: la organización lo revisará. Ya no lo ves.'), 'success');
      } catch (err) {status(err.message, 'error');}
    });
    tool(T('Bloquear'), () => blockRider(c.pilot_id, c.pilot));
  }
  return node('div', {className: 'comment'}, [
    node('p', {}, [node('b', {textContent: c.pilot}), ' ', c.text]),
    node('small', {}, [ago(c.at), ...(c.reports ? [' · ⚑ ' + (c.reports === 1 ? T('1 denuncia') : T('{n} denuncias', {n: c.reports}))] : []), ...tools])]);
}

function redraw(p) {
  const old = cards.get(p.key), fresh = card(p);
  cards.set(p.key, fresh);
  old.replaceWith(fresh);
}

// Neither sees the other here any more, and they stop being friends.
async function blockRider(id, name) {
  if (!window.confirm(T('¿Bloquear a {name}? Dejaréis de veros en el tablón y dejaréis de ser amigos. Puedes desbloquearlo en Tu cuenta.', {name}))) return;
  try {
    await shell.api.block(id);
    await load();
    status(T('Has bloqueado a {name}.', {name}), 'success');
  } catch (err) {status(err.message, 'error');}
}

// ---- The board, a page at a time

async function load(more = false) {
  const data = await shell.api.feed(more ? next : null);
  if (!more) {posts = []; cards.clear(); $('posts').replaceChildren();}
  posts.push(...data.posts);
  next = data.next;
  $('more').hidden = !next;
  for (const p of data.posts) {
    const c = card(p);
    cards.set(p.key, c);
    $('posts').append(c);
  }
  if (!posts.length) $('posts').replaceChildren(node('div', {className: 'panel'}, [node('div', {className: 'panel-content feed-empty'}, [
    node('p', {textContent: T('Todavía no hay nada en el tablón. Sube una ruta en Entrenamiento o invita allí a tus amigos: sus bajadas saldrán aquí.')}),
    node('a', {className: 'btn outline small', href: './entrenamiento.html', textContent: T('Ir a Entrenamiento')})])]));
  if (!more && shell.me?.organizer) await loadReports(data.reported);
}

// For the organization: the reported comments, to keep or delete.
async function loadReports(count) {
  $('reportsPanel').hidden = !count;
  if (!count) return;
  const list = await shell.api.reportedComments();
  $('reportsCount').textContent = String(list.length);
  $('reports').replaceChildren(...list.map(c => {
    const keep = node('button', {type: 'button', className: 'btn outline small', textContent: T('Mantener')});
    const remove = node('button', {type: 'button', className: 'btn danger small', textContent: T('Borrar')});
    keep.addEventListener('click', () => decide(() => shell.api.keepComment(c.id)));
    remove.addEventListener('click', () => decide(() => shell.api.deleteComment(c.id)));
    return node('div', {className: 'item reported'}, [
      node('span', {}, [node('b', {textContent: c.pilot + ': '}), c.text,
        node('small', {textContent: ' · ⚑ ' + (c.reports === 1 ? T('1 denuncia') : T('{n} denuncias', {n: c.reports})) + ' · ' + ago(c.at)})]),
      node('span', {className: 'decide'}, [keep, remove])]);
  }));
}
async function decide(action) {
  try {await action(); await load();}
  catch (err) {status(err.message, 'error');}
}

$('more').addEventListener('click', async () => {
  $('more').disabled = true;
  try {await load(true);} catch (err) {status(err.message, 'error');}
  finally {$('more').disabled = false;}
});

// A recording kept on the device that was never saved (grabar.mjs): the app opens here now, not in Grabar.
try {$('unsaved').hidden = !JSON.parse(localStorage.getItem('dhtrails:grabacion'))?.fixes?.length;} catch {}

async function start() {
  shell = await startShell('tablon');
  const show = async () => {
    $('workspace').hidden = !shell.me;
    $('signedOut').hidden = !!shell.me;
    if (!shell.me) {
      if (shell.api) shell.askLogin(T('Entra con tu cuenta para ver el tablón.'));
      return;
    }
    await load();
  };
  shell.onUser(() => show().catch(err => status(err.message, 'error')));
  if (!shell.api) {$('signedOut').hidden = false; return;}
  await show();
}
start().catch(err => status('Error: ' + err.message, 'error'));
