// DH Trails — service worker. It does one thing: receive a GPX or TCX shared to the installed app from
// another one (Android: Strava, the watch's app, the files app...) and keep it until the training page
// picks it up. Every other request goes to the network as usual: the app works with its server.
const INBOX = 'dh-compartido';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.href !== new URL('compartir', self.registration.scope).href) return;
  event.respondWith((async () => {
    const files = [];
    try {(await event.request.formData()).getAll('file').forEach(f => {if (typeof f !== 'string' && f.size) files.push(f);});}
    catch {}
    // Only the last shared file is kept: a new one replaces it.
    const inbox = await caches.open(INBOX);
    await Promise.all((await inbox.keys()).map(key => inbox.delete(key)));
    if (files[0]) await inbox.put(new URL('compartido', self.registration.scope).href, new Response(files[0], {headers: {
      'Content-Type': files[0].type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(files[0].name || 'ruta.gpx')}}));
    return Response.redirect(new URL('entrenamiento.html?compartido', self.registration.scope).href, 303);
  })());
});
