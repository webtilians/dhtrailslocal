// DH Trails — Social: your friends (requests, the list, adding one by their rider name; backend: app/friends.py)
// and your groups. In a group, riders out together (a guide's clients, a club, friends) see each other on a
// map, with who guides, who drives the van up (the shuttle) and the group's meeting points; touching a rider
// says how far they are and which way. Each rider shares their location group by group; in the app for
// Android and iPhone it goes on with the phone locked while this page is open (backend: app/groups.py).
import {ageText, locationSender, whereFrom} from './group-share.mjs';
import {haversine} from './gps-engine.mjs';
import {$, node, say, startShell, createMap} from './app-shell.mjs';
import {T} from './i18n.mjs';

const POLL_MS = 10000;     // the group's map is asked for again this often while on screen
const FRESH_S = 5 * 60;    // places older than this are drawn faded
const POOR_M = 100;        // your own fixes less precise than this are not used for distances
const ROLE_ICON = {guide: '🧭', shuttle: '🚐'};
const roleName = role => role === 'guide' ? T('Guía') : T('Remonte');
const AVATAR_COLORS = ['#1f6fb2', '#2a8a5f', '#9a4fb5', '#b8632a', '#b23a52', '#357f8f', '#7a6a1f'];
const avatarColor = id => AVATAR_COLORS[[...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initial = name => (name.trim()[0] || '?').toUpperCase();
const status = (message, type = '') => {$('status').hidden = !message; say($('status'), message, type);};

let shell = null, sender = null, groups = [], invitations = [], friends = [], friendRequests = [], sentRequests = [];
let openId = null, current = null, fetchedAt = 0, pollTimer = 0;
let myFix = null, stopGps = null, gpsMode = null, gpsQueue = Promise.resolve(), wakeLock = null;
let view = null, ridersLayer = null, pointsLayer = null, meMarker = null, fitted = false, pointsKey = '';
const riders = new Map();       // member id → {marker, data, look}
const statusOf = new Map();     // member id → the line that says where they are
let placing = null;             // the new meeting point's marker, while putting one

// ---- The GPS: the app's native plugin (with the phone locked too, while sharing), the browser's elsewhere
const cap = window.Capacitor;
const native = cap?.isNativePlatform?.() && cap.PluginHeaders?.some(p => p.name === 'BackgroundGeolocation') ? {
  addWatcher: (options, callback) => cap.nativeCallback('BackgroundGeolocation', 'addWatcher', options, callback),
  removeWatcher: options => cap.nativePromise('BackgroundGeolocation', 'removeWatcher', options),
} : null;
async function watch(background, onFix, onError) {
  if (native) {
    const options = {requestPermissions: true, stale: false, distanceFilter: 0};
    // With a message the app goes on with the phone locked; Android shows it in a notification.
    if (background) Object.assign(options, {backgroundTitle: 'DH Trails', backgroundMessage: T('Compartiendo tu ubicación con tu grupo')});
    const id = await native.addWatcher(options, (location, error) => {
      if (error) return onError(error);
      onFix({lat: location.latitude, lon: location.longitude, ele: location.altitude ?? null, accuracy: location.accuracy,
        speed: location.speed ?? null});
    });
    return () => native.removeWatcher({id});
  }
  if (!navigator.geolocation) {onError({message: T('Este navegador no da acceso al GPS.')}); return () => {};}
  const id = navigator.geolocation.watchPosition(p => onFix({lat: p.coords.latitude, lon: p.coords.longitude,
    ele: p.coords.altitude, accuracy: p.coords.accuracy, speed: p.coords.speed}), onError,
    {enableHighAccuracy: true, maximumAge: 5000, timeout: 60000});
  return () => navigator.geolocation.clearWatch(id);
}
const sharingAnywhere = () => groups.some(g => g.sharing);
// The GPS goes while a group is on screen (for the distances) or while you share your location with one.
function syncGps() {
  gpsQueue = gpsQueue.then(async () => {
    const want = shell?.me && sharingAnywhere() ? 'background' : shell?.me && openId ? 'foreground' : null;
    if (want === gpsMode) return;
    if (stopGps) {try {await stopGps();} catch {} stopGps = null;}
    gpsMode = want;
    if (want) stopGps = await watch(want === 'background', onFix, onGpsError);
    await keepAwake();
  }).catch(err => {gpsMode = null; onGpsError(err);});
  return gpsQueue;
}
// In a browser the screen stays on while sharing: the GPS stops when it goes off.
async function keepAwake() {
  if (native || !navigator.wakeLock) return;
  if (!sharingAnywhere()) {try {await wakeLock?.release();} catch {} wakeLock = null; return;}
  if (document.visibilityState === 'visible' && !wakeLock) {
    try {wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => {wakeLock = null;});} catch {}
  }
}
let drawnAt = 0;
function onFix(fix) {
  if (sharingAnywhere()) sender?.add(fix);
  if (fix.accuracy > POOR_M && myFix) return;
  const first = !myFix;
  myFix = fix;
  drawMe();
  if (first && !fitted && view) {view.map.setView([fix.lat, fix.lon], 15); fitted = true;}
  // The distances follow you, every couple of seconds.
  if (first || Date.now() - drawnAt > 2000) {drawnAt = Date.now(); drawDistances();}
}
function onGpsError(error) {
  const denied = error?.code === 1 || error?.code === 'NOT_AUTHORIZED' || /denied|permission/i.test(error?.message || '');
  status(denied ? T('Sin permiso para usar el GPS. Actívalo en los ajustes del móvil para esta app o este navegador.') :
    T('El GPS no responde: {error}', {error: error?.message || error}), 'error');
}

// ---- Your groups and your invitations
// Your groups, your friends and what waits for you (friend requests, invitations to groups). The menu's
// count of what waits is drawn again too.
async function loadGroups() {
  const [data, mates] = await Promise.all([shell.api.groups(), shell.api.friends()]);
  groups = data.groups;
  invitations = data.invitations;
  friends = mates.friends;
  friendRequests = mates.incoming;
  sentRequests = mates.outgoing;
  drawInvitations();
  drawFriends();
  drawList();
  syncGps();
  shell.refreshPending?.();
}

function drawInvitations() {
  const waiting = friendRequests.length + invitations.length;
  $('invitations').hidden = !waiting;
  $('invitationsCount').textContent = String(waiting);
  $('invitationList').replaceChildren(...friendRequests.map(f => {
    const yes = node('button', {type: 'button', className: 'btn primary small', textContent: T('Aceptar')});
    const no = node('button', {type: 'button', className: 'btn outline small', textContent: T('Rechazar')});
    yes.addEventListener('click', () => act(yes, async () => {
      await shell.api.acceptFriend(f.id);
      await loadGroups();
      status(T('Ahora {name} y tú veis vuestras bajadas.', {name: f.name}), 'success');
    }));
    no.addEventListener('click', () => act(no, async () => {await shell.api.removeFriend(f.id); await loadGroups();}));
    return node('div', {className: 'item'}, [
      node('span', {}, [node('b', {textContent: f.name}), node('small', {textContent: ' · ' + T('quiere ser tu amigo')})]),
      node('span', {className: 'decide'}, [yes, no])]);
  }), ...invitations.map(g => {
    const yes = node('button', {type: 'button', className: 'btn primary small', textContent: T('Aceptar')});
    const no = node('button', {type: 'button', className: 'btn outline small', textContent: T('Rechazar')});
    yes.addEventListener('click', () => act(yes, async () => {
      await shell.api.acceptGroup(g.id);
      await loadGroups();
      location.hash = g.id;
    }));
    no.addEventListener('click', () => act(no, async () => {
      await shell.api.removeFromGroup(g.id, shell.me.id);
      await loadGroups();
    }));
    return node('div', {className: 'item'}, [
      node('span', {}, [node('b', {textContent: g.name}), node('small', {textContent: ' · ' + T('te invita {name}', {name: g.invited_by}) +
        ' · ' + riderCount(g.members)})]),
      node('span', {className: 'decide'}, [yes, no])]);
  }));
}
const riderCount = n => n === 1 ? T('1 piloto') : T('{n} pilotos', {n});

// ---- Friends: they compare their training runs and see them on the board
function drawFriends() {
  $('friendsCount').textContent = friends.length ? String(friends.length) : '';
  const row = (f, note, label, action) => {
    const button = node('button', {type: 'button', textContent: label});
    button.addEventListener('click', () => action(button));
    const avatar = node('span', {className: 'avatar', textContent: initial(f.name), ariaHidden: 'true'});
    avatar.style.background = avatarColor(f.id);
    return node('div', {className: 'item member'}, [
      node('div', {className: 'member-main'}, [avatar, node('div', {className: 'member-text'}, [
        node('b', {textContent: f.name}), ...(note ? [node('small', {className: 'member-status', textContent: note})] : [])])]),
      node('div', {className: 'member-tools'}, [button])]);
  };
  $('friendList').replaceChildren(...(friends.length || sentRequests.length ? [
    ...friends.map(f => row(f, '', T('Quitar'), button => {
      if (!window.confirm(T('¿Dejar de ser amigos con {name}? Dejaréis de ver vuestras bajadas.', {name: f.name}))) return;
      act(button, async () => {await shell.api.removeFriend(f.id); await loadGroups();});
    })),
    ...sentRequests.map(f => row(f, T('Solicitud enviada: aún no la ha aceptado'), T('Cancelar'), button =>
      act(button, async () => {await shell.api.removeFriend(f.id); await loadGroups();}))),
  ] : [node('p', {className: 'placeholder', textContent: T('Todavía no tienes amigos en la app. Añade a alguien por su nombre de piloto.')})]));
}
$('friendForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('friendName').value.trim();
  if (!name) return $('friendName').focus();
  act(event.submitter || $('friendForm').querySelector('button'), async () => {
    const result = await shell.api.addFriend(name);
    $('friendName').value = '';
    await loadGroups();
    status(result.status === 'accepted' ? T('Ya sois amigos con {name}.', {name: result.name}) :
      T('Solicitud enviada a {name}: la verá en su pestaña Social.', {name: result.name}), 'success');
  });
});

function drawList() {
  $('groupsCount').textContent = String(groups.length);
  const sharing = groups.filter(g => g.sharing);
  $('sharingBanner').hidden = !sharing.length;
  $('sharingBanner').textContent = '📍 ' + T('Compartes tu ubicación con: {names}.', {names: sharing.map(g => g.name).join(', ')}) + ' ' +
    (native ? T('Deja esta pestaña abierta: sigue con el móvil bloqueado.') : T('Deja esta página abierta y la pantalla encendida.'));
  $('groupList').replaceChildren(...(groups.length ? groups.map(g => node('a', {className: 'item group-item', href: '#' + g.id}, [
    node('span', {}, [node('b', {textContent: g.name}),
      node('small', {textContent: ' · ' + (g.mine ? T('lo has creado tú') : T('de {name}', {name: g.owner})) + ' · ' + riderCount(g.members)})]),
    node('span', {className: 'group-badges'}, [
      ...(g.role ? [node('span', {className: 'badge muted', textContent: ROLE_ICON[g.role] + ' ' + roleName(g.role)})] : []),
      ...(g.sharing ? [node('span', {className: 'badge ok', textContent: '📍 ' + T('Compartiendo')})] : []),
      node('span', {className: 'go', textContent: '→', ariaHidden: 'true'})])])) :
    [node('p', {className: 'placeholder', textContent: T('Todavía no estás en ningún grupo. Crea uno para vuestra salida e invita a los que vienen.')})]));
}

$('createForm').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('groupName').value.trim();
  if (!name) return $('groupName').focus();
  const button = event.submitter || $('createForm').querySelector('button');
  await act(button, async () => {
    const made = await shell.api.createGroup(name);
    $('groupName').value = '';
    await loadGroups();
    location.hash = made.id;
  });
});

// A button's action: disabled meanwhile, and what went wrong said.
async function act(button, action) {
  if (button) button.disabled = true;
  try {await action(); return true;}
  catch (err) {status(err.message, 'error'); return false;}
  finally {if (button) button.disabled = false;}
}

// ---- One group: its map, its riders and its meeting points
function route() {
  const id = location.hash.slice(1);
  return /^[0-9a-f-]{36}$/i.test(id) ? openGroup(id) : closeGroup();
}
window.addEventListener('hashchange', () => route().catch(err => status(err.message, 'error')));

async function openGroup(id) {
  if (!shell.me) return;
  if (openId !== id) {
    openId = id; current = null; fitted = false; pointsKey = '';
    riders.forEach(r => ridersLayer?.removeLayer(r.marker));
    riders.clear();
    pointsLayer?.clearLayers();
    cancelPoint();
  }
  $('listView').hidden = true;
  $('groupView').hidden = false;
  // Inside a group, the map goes to the top: on a phone it is what matters on the trail.
  document.querySelector('main').classList.add('in-group');
  status('');
  ensureMap();
  await loadGroup();
  if (!fitted) fitAll();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {if (document.visibilityState === 'visible' && openId) loadGroup().catch(() => {});}, POLL_MS);
  syncGps();
  window.scrollTo({top: 0});
}
async function closeGroup() {
  openId = null; current = null;
  clearInterval(pollTimer);
  cancelPoint();
  $('groupView').hidden = true;
  $('listView').hidden = false;
  document.querySelector('main').classList.remove('in-group');
  if (shell.me) await loadGroups().catch(err => status(err.message, 'error'));
  syncGps();
}
$('back').addEventListener('click', event => {event.preventDefault(); location.hash = '';});

async function loadGroup() {
  const id = openId;
  let data;
  try {data = await shell.api.group(id);}
  catch (err) {
    if (err.status !== 404) throw err;
    status(T('Ese grupo ya no existe o ya no estás en él.'), 'error');
    location.hash = '';
    return;
  }
  if (id !== openId) return;
  current = data;
  fetchedAt = Date.now();
  const mine = groups.find(g => g.id === data.id);
  if (mine && mine.sharing !== data.sharing) {mine.sharing = data.sharing; syncGps();}
  $('groupTitle').textContent = data.name;
  drawShare();
  drawRiders();
  drawPoints();
  drawMembers();
  drawDistances();
  await drawInvite();
  const leave = $('leave');
  leave.textContent = data.mine ? T('Borrar el grupo') : T('Salir del grupo');
}

const me = () => current?.members.find(m => m.me);
// Where a rider is: you, by your own GPS; the others, by the last place they sent. How old that is, in s.
const placeOf = m => m.me && myFix ? myFix : m.position;
const ageOf = m => m.me && myFix ? 0 : m.position ? m.position.age_s + (Date.now() - fetchedAt) / 1000 : Infinity;

// ---- Sharing your location with this group
function drawShare() {
  const on = current.sharing;
  $('shareBtn').textContent = on ? '■ ' + T('Dejar de compartir') : '📍 ' + T('Compartir mi ubicación');
  $('shareBtn').className = 'btn full rec-button ' + (on ? 'outline' : 'primary');
  $('shareNote').textContent = !on ? T('El grupo no ve dónde estás. Tú sí ves a los que comparten su ubicación.') :
    native ? T('El grupo ve dónde estás. Puedes bloquear el móvil: sigue compartiéndolo mientras esta pestaña esté abierta, o mientras grabas en Grabar.') :
    T('El grupo ve dónde estás mientras esta página esté abierta y la pantalla encendida, o mientras grabas en Grabar. Con la app para Android o iPhone sigue con el móvil bloqueado.');
}
$('shareBtn').addEventListener('click', () => act($('shareBtn'), async () => {
  const on = !current.sharing;
  await shell.api.shareWithGroup(current.id, on);
  current.sharing = on;
  const mine = groups.find(g => g.id === current.id);
  if (mine) mine.sharing = on;
  if (on) {sender.reset(); if (myFix) await sender.add(myFix);}
  drawShare();
  await syncGps();
  await loadGroup();
}));

// ---- The map
function ensureMap() {
  if (view) {setTimeout(() => view.map.invalidateSize(), 60); return;}
  view = createMap('groupMap');
  ridersLayer = view.add(L.layerGroup());
  pointsLayer = view.add(L.layerGroup());
  view.map.on('click', event => {if (!$('pointForm').hidden) placePoint(event.latlng);});
  setTimeout(() => view.map.invalidateSize(), 60);
}
function drawMe() {
  if (!view || !myFix) return;
  if (meMarker) meMarker.setLatLng([myFix.lat, myFix.lon]);
  else {
    meMarker = view.add(L.circleMarker([myFix.lat, myFix.lon], {radius: 9, color: '#06121e', weight: 3, fillColor: '#ffe066', fillOpacity: 1}));
    meMarker.bindTooltip(T('Tú'), {permanent: true, direction: 'bottom', offset: [0, 10], className: 'rider-label'});
  }
  meMarker.bringToFront();
}
function riderIcon(m, stale) {
  const pin = node('div', {className: 'rider-pin' + (m.role ? ' role-' + m.role : '') + (stale ? ' stale' : ''), textContent: initial(m.name)});
  pin.style.background = avatarColor(m.id);
  if (m.role) pin.append(node('span', {className: 'role-badge', textContent: ROLE_ICON[m.role]}));
  return L.divIcon({html: pin, className: '', iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -18]});
}
// The riders who share their location, each with their initial (and 🧭 or 🚐); faded when it is old.
function drawRiders() {
  const seen = new Set();
  for (const m of current.members) {
    if (!m.position || (m.me && myFix)) continue;
    seen.add(m.id);
    const stale = ageOf(m) > FRESH_S;
    const look = [m.role, stale, m.name].join('|');
    const label = m.name + (stale ? ' · ' + ageText(ageOf(m)) : '');
    let r = riders.get(m.id);
    if (!r) {
      const marker = L.marker([m.position.lat, m.position.lon], {icon: riderIcon(m, stale), riseOnHover: true});
      marker.bindTooltip(label, {permanent: true, direction: 'bottom', offset: [0, 16], className: 'rider-label'});
      marker.bindPopup(() => riderPopup(riders.get(m.id).data));
      ridersLayer.addLayer(marker);
      r = {marker, look};
      riders.set(m.id, r);
    } else {
      r.marker.setLatLng([m.position.lat, m.position.lon]);
      if (r.look !== look) {r.marker.setIcon(riderIcon(m, stale)); r.look = look;}
      r.marker.setTooltipContent(label);
    }
    r.data = m;
    if (r.marker.isPopupOpen()) r.marker.getPopup().setContent(() => riderPopup(riders.get(m.id).data));
  }
  for (const [id, r] of riders) if (!seen.has(id)) {ridersLayer.removeLayer(r.marker); riders.delete(id);}
}
function riderPopup(m) {
  const where = whereFrom(myFix, placeOf(m));
  const speed = m.position?.speed > 1.5 ? ' · ' + Math.round(m.position.speed * 3.6) + ' km/h' : '';
  const rough = m.position?.accuracy > 50 ? ' · ±' + Math.round(m.position.accuracy) + ' m' : '';
  return node('div', {className: 'rider-popup'}, [
    node('b', {textContent: m.name}),
    ...(m.role ? [node('div', {textContent: ROLE_ICON[m.role] + ' ' + roleName(m.role)})] : []),
    node('div', {className: 'popup-where', textContent: where ? '📏 ' + where.text : T('Activa tu ubicación para ver a qué distancia está.')}),
    node('small', {textContent: T('Visto {age}', {age: ageText(ageOf(m))}) + speed + rough})]);
}
function focusRider(m) {
  const place = placeOf(m);
  if (!place) return;
  view.map.setView([place.lat, place.lon], Math.max(view.map.getZoom(), 16));
  riders.get(m.id)?.marker.openPopup();
  $('groupMap').scrollIntoView({behavior: 'smooth', block: 'center'});
}
function fitAll() {
  if (!view || !current) return;
  const places = [...current.members.map(placeOf).filter(Boolean), ...current.points, ...(myFix ? [myFix] : [])].map(p => [p.lat, p.lon]);
  if (places.length === 1) view.map.setView(places[0], 15);
  else if (places.length) view.fit(places, 40);
  fitted = places.length > 0;
}
$('fitAll').addEventListener('click', fitAll);
$('centerMe').addEventListener('click', () => {
  if (myFix) view.map.setView([myFix.lat, myFix.lon], Math.max(view.map.getZoom(), 16));
  else status(T('Esperando al GPS…'));
});

// ---- The guides and the van, always in sight; for a guide, who is furthest away
function drawDistances() {
  if (!current) return;
  const chips = [];
  const chip = (m, title) => {
    const where = whereFrom(myFix, placeOf(m));
    const text = !m.position && !(m.me && myFix) ? T('no comparte su ubicación') :
      (where ? where.distance : T('sin tu ubicación')) + ' · ' + ageText(ageOf(m));
    const button = node('button', {type: 'button', className: 'key-chip' + (m.position ? '' : ' off')}, [
      title + ' ', node('b', {textContent: m.name}), ' · ' + text]);
    button.addEventListener('click', () => focusRider(m));
    chips.push(button);
  };
  for (const role of ['guide', 'shuttle'])
    for (const m of current.members) if (m.role === role && m.accepted && !m.me) chip(m, ROLE_ICON[role] + ' ' + roleName(role) + ':');
  if (me()?.role === 'guide' && myFix) {
    const far = current.members.filter(m => !m.me && m.position && !m.role)
      .map(m => ({m, metres: haversine(myFix, m.position)})).sort((a, b) => b.metres - a.metres)[0];
    if (far) chip(far.m, '📏 ' + T('Más lejos de ti:'));
  }
  $('keyPeople').replaceChildren(...chips);
  for (const m of current.members) statusOf.get(m.id)?.replaceChildren(memberStatus(m));
  $('pointList').querySelectorAll('[data-point]').forEach(el => {
    const p = current.points.find(x => x.id === el.dataset.point);
    if (p) el.textContent = pointLine(p);
  });
}

// ---- The riders: guides first, then the van, then the others by how near they are
function memberStatus(m) {
  if (!m.accepted) return T('Invitado: aún no ha aceptado');
  if (m.me) return m.sharing ? T('Compartes tu ubicación con el grupo') : T('No compartes tu ubicación con el grupo');
  if (!m.position) return T('No comparte su ubicación');
  const where = whereFrom(myFix, m.position);
  return (where ? where.text + ' · ' : '') + T('visto {age}', {age: ageText(ageOf(m))});
}
function drawMembers() {
  const order = m => [m.role === 'guide' ? 0 : m.role === 'shuttle' ? 1 : 2, !m.accepted ? 3 : m.position ? 0 : m.me ? 1 : 2,
    m.position && myFix ? haversine(myFix, m.position) : Infinity];
  const sorted = [...current.members].sort((a, b) => {
    const x = order(a), y = order(b);
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] || a.name.localeCompare(b.name);
  });
  $('membersCount').textContent = String(current.members.filter(m => m.accepted).length);
  statusOf.clear();
  $('memberList').replaceChildren(...sorted.map(m => {
    const line = node('small', {className: 'member-status', textContent: memberStatus(m)});
    statusOf.set(m.id, line);
    const avatar = node('span', {className: 'avatar' + (m.accepted ? '' : ' invited'), textContent: initial(m.name), ariaHidden: 'true'});
    avatar.style.background = avatarColor(m.id);
    const main = node('div', {className: 'member-main'}, [avatar, node('div', {className: 'member-text'}, [
      node('b', {textContent: m.name + (m.me ? ' (' + T('tú') + ')' : '')}),
      ...(m.role ? [' ', node('span', {className: 'badge muted', textContent: ROLE_ICON[m.role] + ' ' + roleName(m.role)})] : []),
      ...(m.owner ? [' ', node('span', {className: 'badge muted', textContent: T('Creador')})] : []),
      line])]);
    if (placeOf(m)) {main.classList.add('can-focus'); main.addEventListener('click', () => focusRider(m));}
    const tools = node('div', {className: 'member-tools'});
    if (current.mine && m.accepted) {
      const role = node('select', {ariaLabel: T('Papel de {name} en el grupo', {name: m.name})}, [
        node('option', {value: '', textContent: '—'}),
        node('option', {value: 'guide', textContent: ROLE_ICON.guide + ' ' + T('Guía')}),
        node('option', {value: 'shuttle', textContent: ROLE_ICON.shuttle + ' ' + T('Remonte')})]);
      role.value = m.role || '';
      role.addEventListener('change', () => act(role, async () => {
        await shell.api.setGroupRole(current.id, m.id, role.value || null);
        await loadGroup();
      }));
      tools.append(role);
    }
    if (current.mine && !m.me) {
      const out = node('button', {type: 'button', textContent: m.accepted ? T('Quitar') : T('Cancelar')});
      out.addEventListener('click', () => {
        if (!window.confirm(m.accepted ? T('¿Quitar a {name} del grupo?', {name: m.name}) : T('¿Cancelar la invitación a {name}?', {name: m.name}))) return;
        act(out, async () => {await shell.api.removeFromGroup(current.id, m.id); await loadGroup();});
      });
      tools.append(out);
    }
    return node('div', {className: 'item member'}, [main, tools]);
  }));
}

// ---- Inviting (whoever created the group): their friends with a touch, anyone else by their name
async function drawInvite() {
  $('inviteBox').hidden = !current.mine;
  if (!current.mine) return;
  const inside = new Set(current.members.map(m => m.id));
  $('friendChips').replaceChildren(...friends.filter(f => !inside.has(f.id)).map(f => {
    const chip = node('button', {type: 'button', className: 'friend-chip', textContent: '+ ' + f.name, title: T('Invitar a {name}', {name: f.name})});
    chip.addEventListener('click', () => invite(f.name, chip));
    return chip;
  }));
}
async function invite(name, button) {
  if (await act(button, async () => {
    const sent = await shell.api.inviteToGroup(current.id, name);
    await loadGroup();
    status(T('Invitación enviada a {name}: la verá en su pestaña Social.', {name: sent.name}), 'success');
  })) $('inviteName').value = '';
}
$('inviteForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('inviteName').value.trim();
  if (name) invite(name, event.submitter || $('inviteForm').querySelector('button'));
});

// ---- Meeting points: anyone in the group puts them on the map
const pointLine = p => {
  const where = whereFrom(myFix, p);
  return (where ? where.text + ' · ' : '') + (p.by ? T('lo puso {name}', {name: p.by}) : '');
};
function pointIcon() {
  return L.divIcon({html: '<div class="meet-pin"><span>⚑</span></div>', className: '', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28]});
}
function drawPoints() {
  $('pointsCount').textContent = String(current.points.length);
  const key = JSON.stringify(current.points);
  if (key !== pointsKey) {
    pointsKey = key;
    pointsLayer.clearLayers();
    for (const p of current.points) {
      const marker = L.marker([p.lat, p.lon], {icon: pointIcon()});
      marker.bindTooltip(p.name, {permanent: true, direction: 'top', offset: [0, -30], className: 'point-label'});
      marker.bindPopup(() => {
        const where = whereFrom(myFix, p);
        return node('div', {className: 'rider-popup'}, [node('b', {textContent: '⚑ ' + p.name}),
          node('div', {className: 'popup-where', textContent: where ? '📏 ' + where.text : T('Activa tu ubicación para ver a qué distancia está.')}),
          ...(p.by ? [node('small', {textContent: T('lo puso {name}', {name: p.by})})] : [])]);
      });
      pointsLayer.addLayer(marker);
    }
  }
  $('pointList').replaceChildren(...(current.points.length ? current.points.map(p => {
    const line = node('small', {className: 'member-status', textContent: pointLine(p)});
    line.dataset.point = p.id;
    const main = node('div', {className: 'member-main can-focus'}, [node('span', {className: 'meet-dot', textContent: '⚑', ariaHidden: 'true'}),
      node('div', {className: 'member-text'}, [node('b', {textContent: p.name}), line])]);
    main.addEventListener('click', () => {view.map.setView([p.lat, p.lon], Math.max(view.map.getZoom(), 16)); $('groupMap').scrollIntoView({behavior: 'smooth', block: 'center'});});
    const tools = node('div', {className: 'member-tools'});
    if (p.can_delete) {
      const out = node('button', {type: 'button', textContent: T('Quitar')});
      out.addEventListener('click', () => {
        if (!window.confirm(T('¿Quitar el punto de encuentro «{name}»?', {name: p.name}))) return;
        act(out, async () => {await shell.api.deleteMeetingPoint(current.id, p.id); await loadGroup();});
      });
      tools.append(out);
    }
    return node('div', {className: 'item member'}, [main, tools]);
  }) : [node('p', {className: 'placeholder', textContent: T('Sin puntos de encuentro. Pon uno con «⚑ Punto de encuentro»: el remonte, la salida, el bar…')})]));
}
function placePoint(latlng) {
  if (placing) placing.setLatLng(latlng);
  else {
    placing = view.add(L.marker(latlng, {icon: pointIcon(), draggable: true, opacity: .8}));
    placing.bindTooltip(T('Nuevo punto'), {permanent: true, direction: 'top', offset: [0, -30], className: 'point-label'});
  }
}
function cancelPoint() {
  $('pointForm').hidden = true;
  if (placing && view) view.map.removeLayer(placing);
  placing = null;
  $('pointName').value = '';
}
$('addPoint').addEventListener('click', () => {
  if (!$('pointForm').hidden) return cancelPoint();
  $('pointForm').hidden = false;
});
$('pointHere').addEventListener('click', () => {
  if (!myFix) return status(T('Esperando al GPS…'));
  placePoint([myFix.lat, myFix.lon]);
  view.map.setView([myFix.lat, myFix.lon], Math.max(view.map.getZoom(), 16));
});
$('cancelPoint').addEventListener('click', cancelPoint);
$('pointForm').addEventListener('submit', event => {
  event.preventDefault();
  if (!placing) return status(T('Toca el mapa donde quieras el punto de encuentro, o ponlo donde estás.'));
  const at = placing.getLatLng();
  act($('savePoint'), async () => {
    await shell.api.addMeetingPoint(current.id, {name: $('pointName').value.trim() || T('Punto de encuentro'), lat: at.lat, lon: at.lng});
    cancelPoint();
    await loadGroup();
  });
});

// ---- Leaving the group, or deleting it (whoever created it)
$('leave').addEventListener('click', () => {
  const name = current.name;
  if (!window.confirm(current.mine ? T('¿Borrar el grupo «{name}»? Dejaréis de veros todos y se borran sus puntos de encuentro.', {name}) :
    T('¿Salir del grupo «{name}»? Dejarás de ver a los demás y ellos a ti.', {name}))) return;
  act($('leave'), async () => {
    if (current.mine) await shell.api.deleteGroup(current.id);
    else await shell.api.removeFromGroup(current.id, shell.me.id);
    location.hash = '';
  });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !shell?.me) return;
  keepAwake();
  (openId ? loadGroup() : loadGroups()).catch(() => {});
});
// Another page: the GPS goes off (sharing goes on there only in Grabar, while recording).
window.addEventListener('pagehide', () => {if (stopGps) stopGps();});

async function start() {
  shell = await startShell('social');
  if (shell.api) sender = locationSender(shell.api, {onStopped: () => loadGroups().catch(() => {})});
  const show = async () => {
    $('workspace').hidden = !shell.me;
    $('signedOut').hidden = !!shell.me;
    if (!shell.me) {
      groups = []; openId = null; clearInterval(pollTimer); await syncGps();
      if (shell.api) shell.askLogin(T('Entra con tu cuenta para ver a tus amigos y tus grupos.'));
      return;
    }
    await loadGroups();
    await route();
  };
  shell.onUser(() => show().catch(err => status(err.message, 'error')));
  if (!shell.api) {$('signedOut').hidden = false; return;}
  await show();
}
start().catch(err => status('Error: ' + err.message, 'error'));

