/* Service worker: app shell precached, everything else cache-first once seen.
   The "save offline" button in the sidebar fills the audio cache in bulk. */
const SHELL = 'im-shell-v1';
const FILES = [
  './', 'index.html', 'css/app.css', 'js/data.js', 'js/dsp.js', 'js/audio.js', 'js/ui.js', 'js/views.js', 'js/app.js',
  'manifest.webmanifest', 'assets/icon.svg',
  'assets/fonts/instrument-sans-latin-wght-normal.woff2', 'assets/fonts/instrument-serif-latin-400-normal.woff2',
  'assets/fonts/instrument-serif-latin-400-italic.woff2',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('im-shell-') && k !== SHELL).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isAudio = /\/audio\//.test(req.url);
  if (isAudio) {
    // Range requests from <audio> need a full response to slice; serve the cached whole file.
    e.respondWith(caches.match(req.url, { ignoreSearch: true }).then(hit => hit || fetch(req)));
    return;
  }
  // Shell: network first so updates land, cache as fallback for offline.
  e.respondWith(
    fetch(req).then(res => {
      const copy = res.clone();
      if (res.ok) caches.open(SHELL).then(c => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html')))
  );
});
