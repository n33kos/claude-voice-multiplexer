// Minimal service worker for PWA install support.
// Uses network-first strategy — the app requires a live server connection
// for WebSocket and LiveKit, so offline caching is minimal.

const CACHE_NAME = 'vmux-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  // Let all requests go to the network — we need live connections
  event.respondWith(fetch(event.request));
});
