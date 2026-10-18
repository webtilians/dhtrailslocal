import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// sw.js run as a browser would, with the cache storage kept in a Map.
function worker() {
  const handlers = {}, store = new Map();
  const cache = {
    keys: async () => [...store.keys()].map(url => new Request(url)),
    delete: async request => store.delete(request.url ?? request),
    put: async (url, response) => {store.set(url, response);},
  };
  const self = {addEventListener: (type, fn) => {handlers[type] = fn;}, registration: {scope: 'https://dh.example/'},
    skipWaiting() {}, clients: {claim: async () => {}}};
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), {self, caches: {open: async () => cache}, URL, Response});
  return {handlers, store};
}
async function fetchEvent(handlers, request) {
  let response = null;
  handlers.fetch({request, respondWith: answer => {response = answer;}});
  return response && await response;
}

test('a GPX shared to the installed app is kept for the training page, and nothing else is touched', async () => {
  const {handlers, store} = worker();
  const form = new FormData();
  form.append('file', new File(['<gpx/>'], 'Bicicleta (12).gpx', {type: 'application/gpx+xml'}));
  const response = await fetchEvent(handlers, new Request('https://dh.example/compartir', {method: 'POST', body: form}));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'https://dh.example/entrenamiento.html?compartido');
  const kept = store.get('https://dh.example/compartido');
  assert.equal(decodeURIComponent(kept.headers.get('X-File-Name')), 'Bicicleta (12).gpx');
  assert.equal(kept.headers.get('Content-Type'), 'application/gpx+xml');
  assert.equal(await kept.text(), '<gpx/>');
  // Every other request goes to the network as usual.
  assert.equal(await fetchEvent(handlers, new Request('https://dh.example/api/health')), null);
  assert.equal(await fetchEvent(handlers, new Request('https://dh.example/api/training/routes', {method: 'POST', body: form})), null);
  // A share without a file clears the old one: the page then says that nothing arrived.
  await fetchEvent(handlers, new Request('https://dh.example/compartir', {method: 'POST', body: new FormData()}));
  assert.equal(store.size, 0);
});
