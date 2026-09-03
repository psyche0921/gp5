'use strict';

const CACHE_NAME = 'gp5-pedalboard-v12';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './data/ble_sysex.json',
  './data/cc_commands.json',
  './icons/icon.svg',
];

// cache.addAll(urls) fetches with default cache semantics, which lets the browser's
// own HTTP cache hand back a stale response (GitHub Pages doesn't send no-cache
// headers) even though this is a brand-new SW version trying to snapshot the CURRENT
// files — {cache: 'reload'} forces every install-time fetch to actually hit the network.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(ASSETS.map((url) => fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res)))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first, falling back to network (and caching what we fetch) — the
// pedal connection itself is Bluetooth/USB, not network, so once installed
// this app has no real need to hit the network again.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request, { cache: 'reload' }).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return res;
      });
    })
  );
});
