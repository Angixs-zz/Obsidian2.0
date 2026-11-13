/* Service worker de Obsidian Web.
   Cachea solo la aplicación (HTML, CSS, JS, iconos y demo). La bóveda del
   usuario nunca pasa por aquí: se lee con la File System Access API. */
const CACHE = "obsidian-web-v2.1.0-r4";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./core.js",
  "./theme.js",
  "./styles.css",
  "./favicon.svg",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./vendor/marked.min.js",
  "./vendor/purify.min.js",
  "./demo/manifest.json",
  "./demo/Inicio.md",
  "./demo/Proyectos/App de librería.md",
  "./demo/Lectura/El cuento de la Criada.md",
  "./demo/Escritos/Privilegio.md"
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(SHELL.map((asset) => cache.add(asset)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith("/health")) return;
  if (request.headers.get("range")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put("./index.html", response.clone()).catch(() => {});
        return response;
      } catch {
        return (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
      }
      return response;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
