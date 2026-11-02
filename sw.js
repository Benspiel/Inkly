/* Inkly – Service Worker.
 * Macht Inkly als App installierbar und offline nutzbar. Strategie „Netz zuerst“: Online kommt
 * immer die aktuelle Version vom Server, die Kopie im Cache wird nur ohne Verbindung genutzt.
 * Anfragen an andere Server (z. B. Appwrite) werden nicht angefasst. */
const CACHE = "inkly-v1";
const CORE = [
  "./", "index.html", "styles.css", "app.js", "config.js", "templates.js",
  "vendor/fonts.css", "vendor/jszip.min.js", "vendor/jspdf.umd.min.js", "vendor/appwrite-28.3.0.js",
  "assets/logo-icon.svg", "manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
  );
});
