// DH Trails v0.8 — shared shell: tabs, account dialog and map helpers for every page.
import {discoverApi, createCloudApi} from './api-client.mjs';
import {T, dec, lang, locale, setLang, tServer, translatePage} from './i18n.mjs';

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

// iPhone and iPad (an iPad says it is a Mac, but a Mac has no touch screen).
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// Inside the app for Android or iPhone (Capacitor) there is nothing to install.
const INSTALLED = !!window.Capacitor?.isNativePlatform?.() || window.matchMedia?.('(display-mode: standalone)').matches ||
  navigator.standalone === true;

// The board, time trial, training, recording and circuits are for everyone (riders draw the circuits of their
// area too); tournaments only for the organization.
const TABS = [
  {href: './tablon.html', label: T('Tablón'), page: 'tablon'},
  {href: './index.html', label: T('Time trial'), page: 'timetrial'},
  {href: './entrenamiento.html', label: T('Entrenamiento'), page: 'entrenamiento'},
  {href: './grabar.html', label: T('Grabar'), page: 'grabar'},
  {href: './records.html', label: T('Récords'), page: 'records'},
  {href: './circuitos.html', label: T('Circuitos'), page: 'circuitos'},
  {href: './torneos.html', label: T('Torneos'), page: 'torneos', admin: true},
];

export async function startShell(page) {
  const shell = {api: null, me: null, health: null, listeners: []};
  translatePage();
  // In the app for Android, a route shared to it goes to the training page, which takes it; a page that
  // would take it itself (the time trial) is left before it does.
  if (nativeShare) {
    nativeShare.onShared(() => location.assign('./entrenamiento.html?compartido'));
    if (page !== 'entrenamiento' && (await nativeShare.peek())) {
      location.assign('./entrenamiento.html?compartido');
      await new Promise(() => {});
    }
  }
  // Installed on a phone, the app can receive GPX files shared from other apps (sw.js).
  if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
  // Chrome and Edge can install it: then a button for it, instead of their own banner.
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', event => {event.preventDefault(); installPrompt = event; draw();});
  window.addEventListener('appinstalled', () => {installPrompt = null; draw();});
  // On an iPhone it is installed from the browser's Share menu: the button explains how.
  const iosHelp = IOS && !INSTALLED ? iosInstallDialog() : null;
  if (iosHelp) document.body.append(iosHelp);
  // iOS only lets a file be chosen when it knows its type, and a .gpx saved from another app may not be
  // one of them: there, any file can be chosen (the server checks what it is).
  if (IOS) document.querySelectorAll('input[type=file]').forEach(input => {if (/\.gpx/.test(input.accept)) input.removeAttribute('accept');});
  const nav = $('appNav');
  const tabs = node('div', {className: 'navlinks'});
  const account = node('div', {className: 'account'});
  // ES | EN: the app's language on this device.
  const languages = node('div', {className: 'lang-switch', role: 'group', ariaLabel: T('Idioma')}, ['es', 'en'].map(code => {
    const button = node('button', {type: 'button', textContent: code.toUpperCase(), className: code === lang ? 'selected' : '',
      title: {es: 'Español', en: 'English'}[code]});
    button.addEventListener('click', () => {if (code !== lang) setLang(code);});
    return button;
  }));
  nav.className = 'nav';
  nav.append(node('a', {className: 'logo', href: './tablon.html'}, [
    node('div', {className: 'flag', textContent: '▦', ariaHidden: 'true'}),
    node('div', {}, [node('strong', {innerHTML: 'DH<span>TRAILS</span> LOCAL'}), node('small', {textContent: 'DOWNHILL PERFORMANCE LAB'})])]),
    tabs, account);
  const dialog = authDialog(shell);
  document.body.append(dialog);

  const draw = () => {
    tabs.replaceChildren(...TABS.filter(t => !t.admin || shell.me?.organizer).map(t =>
      node('a', {href: t.href, textContent: t.label, className: t.page === page ? 'selected' : ''})));
    account.replaceChildren(languages);
    if (installPrompt) {
      const install = node('button', {type: 'button', className: 'btn outline', textContent: T('Instalar app'),
        title: T('Como una app en el móvil o el ordenador; en Android aparece al compartir un GPX desde otra app')});
      install.addEventListener('click', async () => {const prompt = installPrompt; installPrompt = null; draw(); await prompt.prompt();});
      account.append(install);
    } else if (iosHelp) {
      const install = node('button', {type: 'button', className: 'btn outline', textContent: T('Instalar app')});
      install.addEventListener('click', () => iosHelp.showModal());
      account.append(install);
    }
    if (!shell.api) return;
    if (shell.me) {
      account.append(shell.me.local ? node('span', {className: 'who', textContent: T('Este PC')}) :
        node('a', {className: 'who', href: './cuenta.html', title: T('Tu cuenta'), textContent: shell.me.display_name || shell.me.email}));
      if (!shell.me.local) {
        const out = node('button', {type: 'button', className: 'text-btn', textContent: T('Salir')});
        out.addEventListener('click', async () => {await shell.api.signOut(); shell.setUser(null);});
        account.append(out);
      }
    } else {
      const enter = node('button', {type: 'button', className: 'btn outline', textContent: T('Entrar')});
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
  dialog.querySelector('.forgot').hidden = !shell.health.password_reset;
  draw();
  return shell;
}

// The app for Android keeps a file shared to it (Share → DH Trails) until a page takes it; through the
// bridge Capacitor puts in the page (the page comes from the server, without Capacitor's own JavaScript).
const cap = typeof window === 'undefined' ? null : window.Capacitor;
const nativeShare = cap?.isNativePlatform?.() && cap.PluginHeaders?.some(p => p.name === 'SharedFile') ? {
  peek: () => cap.nativePromise('SharedFile', 'peek', {}).then(r => !!r?.pending).catch(() => false),
  take: () => cap.nativePromise('SharedFile', 'take', {}).catch(() => null),
  onShared: fn => cap.nativeCallback('SharedFile', 'addListener', {eventName: 'shared'}, fn),
} : null;

// A GPX, TCX or FIT shared to the installed app from another one: the app keeps it, or in the web the
// service worker does and a page opened with ?compartido takes it. It goes into the page's file input.
// {file}, {missing: true} when it did not arrive, or null when nothing was shared.
export async function takeShared(input) {
  const asked = new URLSearchParams(location.search).has('compartido');
  if (!asked && !nativeShare) return null;
  if (asked) history.replaceState(null, '', location.pathname);  // a reload does not take it again
  try {
    let file = null;
    const native = nativeShare ? await nativeShare.take() : null;
    if (native?.data) file = new File([Uint8Array.from(atob(native.data), c => c.charCodeAt(0))], native.name || 'ruta');
    else if (!asked) return null;
    else {
      const kept = await (await caches.open('dh-compartido')).match(new URL('./compartido', location.href).href);
      if (!kept) return {missing: true};
      file = new File([await kept.blob()], decodeURIComponent(kept.headers.get('X-File-Name') || 'ruta.gpx'),
        {type: kept.headers.get('Content-Type') || ''});
    }
    const chosen = new DataTransfer();
    chosen.items.add(file);
    input.files = chosen.files;
    input.dispatchEvent(new Event('change'));
    return {file};
  } catch {return {missing: true};}
}

function iosInstallDialog() {
  const done = node('button', {type: 'button', className: 'btn primary full', textContent: T('Entendido')});
  const dialog = node('dialog', {className: 'auth'}, [node('div', {className: 'auth-form'}, [
    node('h2', {className: 'dialog-title', textContent: T('Instalar DH Trails en el iPhone')}),
    node('ol', {className: 'steps'}, [
      node('li', {textContent: T('Pulsa Compartir en el navegador: el cuadrado con una flecha hacia arriba (en Safari, abajo).')}),
      node('li', {textContent: T('Baja y elige «Añadir a pantalla de inicio».')}),
      node('li', {textContent: T('Pulsa «Añadir». Aparece el icono de DH Trails y la app se abre a pantalla completa.')})]),
    node('p', {className: 'help', textContent: T('Para subir una ruta desde el iPhone, guarda antes el GPX en Archivos y elígelo con «Importar GPX / TCX».')}),
    done])]);
  done.addEventListener('click', () => dialog.close());
  return dialog;
}

function authDialog(shell) {
  const field = (label, input) => node('label', {className: 'field'}, [node('span', {className: 'field-title', textContent: label}), input]);
  const name = node('input', {autocomplete: 'nickname', maxLength: 30, placeholder: T('Ej. Rider Uno')});
  const email = node('input', {type: 'email', autocomplete: 'email', placeholder: T('correo@ejemplo.com')});
  const password = node('input', {type: 'password', autocomplete: 'current-password', minLength: 8});
  const invite = node('input', {autocomplete: 'off', placeholder: T('Te lo da la organización')});
  const note = node('p', {className: 'auth-note help'});
  const feedback = node('p', {className: 'save-feedback', role: 'status'});
  feedback.dataset.base = 'save-feedback';
  const nameField = field(T('Nombre de piloto (sale en la clasificación)'), name);
  const inviteField = node('div', {className: 'invite'}, [field(T('Código de invitación'), invite)]);
  const legal = node('p', {className: 'help invite'}, [T('Al crear la cuenta aceptas la') + ' ',
    node('a', {href: './privacidad.html', target: '_blank', textContent: T('política de privacidad y las normas del tablón')}), '.']);
  let mode = 'login';
  const login = node('button', {type: 'button', className: 'tab-btn selected', textContent: T('Entrar')});
  const signup = node('button', {type: 'button', className: 'tab-btn', textContent: T('Crear cuenta')});
  const submit = node('button', {type: 'submit', className: 'btn primary full', textContent: T('Entrar')});
  const cancel = node('button', {type: 'button', className: 'text-btn', textContent: T('Cancelar')});
  // A forgotten password: the mail gets a link to choose a new one (only when the server can send mail).
  const forgot = node('button', {type: 'button', className: 'text-btn forgot', textContent: T('¿Has olvidado la contraseña?')});
  const passwordField = field(T('Contraseña (mínimo 8 caracteres)'), password);
  const setMode = next => {
    mode = next;
    login.classList.toggle('selected', mode !== 'signup');
    signup.classList.toggle('selected', mode === 'signup');
    nameField.hidden = mode !== 'signup';
    passwordField.hidden = mode === 'forgot';
    inviteField.classList.toggle('off', mode !== 'signup');
    legal.classList.toggle('off', mode !== 'signup');
    forgot.hidden = mode !== 'login' || !shell.health?.password_reset;
    submit.textContent = {login: T('Entrar'), signup: T('Crear cuenta'), forgot: T('Enviar el enlace')}[mode];
    password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    say(feedback, mode === 'forgot' ? T('Escribe el correo de tu cuenta y te enviaremos un enlace para elegir una contraseña nueva.') : '');
  };
  forgot.addEventListener('click', () => {setMode('forgot'); email.focus();});
  login.addEventListener('click', () => setMode('login'));
  signup.addEventListener('click', () => setMode('signup'));
  const form = node('form', {method: 'dialog', className: 'auth-form'}, [
    node('div', {className: 'tab-row'}, [login, signup]), note, nameField, field(T('Correo electrónico'), email),
    passwordField, forgot, inviteField, feedback, submit, legal, cancel]);
  const dialog = node('dialog', {className: 'auth'}, [form]);
  cancel.addEventListener('click', () => dialog.close());
  // Opened again after asking for a link: back to signing in.
  dialog.addEventListener('close', () => {if (mode === 'forgot') setMode('login');});
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!shell.api) return say(feedback, T('No hay conexión con el servidor.'), 'error');
    submit.disabled = true;
    try {
      if (mode === 'forgot') {
        const sent = await shell.api.forgotPassword(email.value.trim());
        return say(feedback, tServer(sent.detail), 'success');
      }
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
// Base maps: OpenStreetMap with the trails, or Esri satellite imagery with place names on top.
// The last choice is remembered on this device (by its Spanish name, in either language).
const BASE_MAP_KEY = 'dhtrailslocal:map:base';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
export function createMap(id) {
  const map = L.map(id, {zoomControl: true}).setView([36.76, -4.46], 12);
  const bases = {
    [T('Mapa')]: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'}),
    [T('Satélite')]: L.layerGroup([
      L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', {maxZoom: 19, maxNativeZoom: 18,
        attribution: T('Imágenes') + ' &copy; Esri, Maxar, Earthstar Geographics'}),
      L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {maxZoom: 19, maxNativeZoom: 18}),
    ]),
  };
  let base = 'Mapa';
  try {if (localStorage.getItem(BASE_MAP_KEY) === 'Satélite') base = 'Satélite';} catch {}
  bases[T(base)].addTo(map);
  L.control.layers(bases, null, {position: 'topright', collapsed: false}).addTo(map);
  map.on('baselayerchange', e => {try {localStorage.setItem(BASE_MAP_KEY, e.name === T('Satélite') ? 'Satélite' : 'Mapa');} catch {}});
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
  // The start's and the finish's initials, in the page's language.
  const glyph = {start: T('Salida')[0], finish: T('Meta')[0], gate: '◆'}[kind];
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
  pin(view, pts[0], 'start', T('Salida'));
  circuit.sectors.forEach((s, i) => pin(view, pts[s.index], 'gate', T('Segmento {n}', {n: i + 1}) + (s.name ? ' · ' + s.name : '')));
  pin(view, pts.at(-1), 'finish', T('Meta'));
  if (fit) view.fit(pts);
  return pts;
}
export const km = metres => dec(metres / 1000, 2) + ' km';
export const dateText = iso => iso ? new Date(iso).toLocaleDateString(locale, {day: 'numeric', month: 'short', year: 'numeric'}) : '—';
