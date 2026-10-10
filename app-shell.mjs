// DH Trails v0.8 — shared shell: tabs, account dialog and map helpers for every page.
import {discoverApi, createCloudApi} from './api-client.mjs';

export const $ = id => document.getElementById(id);
export function node(tag, props = {}, children = []) {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}
export function say(el, message, type = '') {
  el.textContent = message;
  el.className = (el.dataset.base || el.className.split(' ')[0]) + (type ? ' ' + type : '');
}

// Time trial and training are for everyone; circuits and tournaments only for the organization.
const TABS = [
  {href: './index.html', label: 'Time trial', page: 'timetrial'},
  {href: './entrenamiento.html', label: 'Entrenamiento', page: 'entrenamiento'},
  {href: './circuitos.html', label: 'Circuitos', page: 'circuitos', admin: true},
  {href: './torneos.html', label: 'Torneos', page: 'torneos', admin: true},
];

export async function startShell(page) {
  const shell = {api: null, me: null, health: null, listeners: []};
  const nav = $('appNav');
  const tabs = node('div', {className: 'navlinks'});
  const account = node('div', {className: 'account'});
  nav.className = 'nav';
  nav.append(node('a', {className: 'logo', href: './index.html'}, [
    node('div', {className: 'flag', textContent: '▦', ariaHidden: 'true'}),
    node('div', {}, [node('strong', {innerHTML: 'DH<span>TRAILS</span> LOCAL'}), node('small', {textContent: 'DOWNHILL PERFORMANCE LAB'})])]),
    tabs, account);
  const dialog = authDialog(shell);
  document.body.append(dialog);

  const draw = () => {
    tabs.replaceChildren(...TABS.filter(t => !t.admin || shell.me?.organizer).map(t =>
      node('a', {href: t.href, textContent: t.label, className: t.page === page ? 'selected' : ''})));
    account.replaceChildren();
    if (!shell.api) return;
    if (shell.me) {
      account.append(node('span', {className: 'who', textContent: shell.me.local ? 'Este PC' : shell.me.display_name || shell.me.email}));
      if (!shell.me.local) {
        const out = node('button', {type: 'button', className: 'text-btn', textContent: 'Salir'});
        out.addEventListener('click', async () => {await shell.api.signOut(); shell.setUser(null);});
        account.append(out);
      }
    } else {
      const enter = node('button', {type: 'button', className: 'btn outline', textContent: 'Entrar'});
      enter.addEventListener('click', () => shell.askLogin());
      account.append(enter);
    }
  };
  shell.setUser = user => {shell.me = user; draw(); shell.listeners.forEach(fn => fn(user));};
  shell.onUser = fn => shell.listeners.push(fn);
  shell.askLogin = (message = '') => {dialog.querySelector('.auth-note').textContent = message; dialog.showModal();};
  draw();

  const config = await discoverApi();
  if (!config) return shell;
  shell.api = createCloudApi(config);
  shell.health = await shell.api.health();
  shell.me = shell.health.local_mode ? await shell.api.localSession() : await shell.api.user();
  dialog.querySelector('.invite').hidden = !shell.health.invite_required;
  draw();
  return shell;
}

function authDialog(shell) {
  const field = (label, input) => node('label', {className: 'field'}, [node('span', {className: 'field-title', textContent: label}), input]);
  const name = node('input', {autocomplete: 'nickname', maxLength: 30, placeholder: 'Ej. Rider Uno'});
  const email = node('input', {type: 'email', autocomplete: 'email', placeholder: 'correo@ejemplo.com'});
  const password = node('input', {type: 'password', autocomplete: 'current-password', minLength: 8});
  const invite = node('input', {autocomplete: 'off', placeholder: 'Te lo da la organización'});
  const note = node('p', {className: 'auth-note help'});
  const feedback = node('p', {className: 'save-feedback', role: 'status'});
  feedback.dataset.base = 'save-feedback';
  const nameField = field('Nombre de piloto (sale en la clasificación)', name);
  const inviteField = node('div', {className: 'invite'}, [field('Código de invitación', invite)]);
  let mode = 'login';
  const login = node('button', {type: 'button', className: 'tab-btn selected', textContent: 'Entrar'});
  const signup = node('button', {type: 'button', className: 'tab-btn', textContent: 'Crear cuenta'});
  const submit = node('button', {type: 'submit', className: 'btn primary full', textContent: 'Entrar'});
  const cancel = node('button', {type: 'button', className: 'text-btn', textContent: 'Cancelar'});
  const setMode = next => {
    mode = next;
    login.classList.toggle('selected', mode === 'login');
    signup.classList.toggle('selected', mode === 'signup');
    nameField.hidden = mode === 'login';
    inviteField.classList.toggle('off', mode === 'login');
    submit.textContent = mode === 'login' ? 'Entrar' : 'Crear cuenta';
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  };
  login.addEventListener('click', () => setMode('login'));
  signup.addEventListener('click', () => setMode('signup'));
  const form = node('form', {method: 'dialog', className: 'auth-form'}, [
    node('div', {className: 'tab-row'}, [login, signup]), note, nameField, field('Correo electrónico', email),
    field('Contraseña (mínimo 8 caracteres)', password), inviteField, feedback, submit, cancel]);
  const dialog = node('dialog', {className: 'auth'}, [form]);
  cancel.addEventListener('click', () => dialog.close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!shell.api) return say(feedback, 'No hay conexión con el servidor.', 'error');
    submit.disabled = true;
    try {
      const result = mode === 'login'
        ? await shell.api.signIn(email.value.trim(), password.value)
        : await shell.api.signUp(email.value.trim(), password.value, {displayName: name.value.trim(), inviteCode: invite.value.trim()});
      password.value = '';
      say(feedback, '');
      dialog.close();
      shell.setUser(result.user);
    } catch (err) {say(feedback, err.message, 'error');}
    finally {submit.disabled = false;}
  });
  setMode('login');
  return dialog;
}

// ---- Map helpers shared by every page
export function createMap(id) {
  const map = L.map(id, {zoomControl: true}).setView([36.76, -4.46], 12);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'}).addTo(map);
  const layers = [];
  return {
    map,
    add(layer) {layer.addTo(map); layers.push(layer); return layer;},
    clear() {layers.splice(0).forEach(layer => map.removeLayer(layer));},
    fit(points, padding = 30) {if (points.length) map.fitBounds(L.latLngBounds(points), {padding: [padding, padding]});},
  };
}
const MARKER_COLORS = {start: '#1fd68c', finish: '#f85d74', gate: '#f2c34f'};
export function pin(view, latlon, kind, label, onDrop) {
  const glyph = {start: 'S', finish: 'M', gate: '◆'}[kind];
  const html = '<div class="pin" style="background:' + MARKER_COLORS[kind] + '">' + glyph + '</div>';
  const marker = view.add(L.marker(latlon, {draggable: !!onDrop, bubblingMouseEvents: false,
    icon: L.divIcon({html, className: '', iconSize: [28, 28], iconAnchor: [14, 14]})}));
  if (label) marker.bindTooltip(label, {direction: 'top', offset: [0, -12]});
  if (onDrop) marker.on('dragend', () => onDrop(marker.getLatLng()));
  return marker;
}
// A saved circuit: blue line, start, finish and the segment boundaries.
export function drawCircuit(view, circuit, {fit = true, color = '#229fff', weight = 6} = {}) {
  const pts = circuit.points.map(p => [p[0], p[1]]);
  view.add(L.polyline(pts, {color, weight, opacity: .9}));
  pin(view, pts[0], 'start', 'Salida');
  circuit.sectors.forEach((s, i) => pin(view, pts[s.index], 'gate', 'Segmento ' + (i + 1) + (s.name ? ' · ' + s.name : '')));
  pin(view, pts.at(-1), 'finish', 'Meta');
  if (fit) view.fit(pts);
  return pts;
}
export const km = metres => (metres / 1000).toFixed(2).replace('.', ',') + ' km';
export const dateText = iso => iso ? new Date(iso).toLocaleDateString('es-ES', {day: 'numeric', month: 'short', year: 'numeric'}) : '—';
