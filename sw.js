const CACHE = "sabal-booth-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./admin.html",
  "./css/app.css",
  "./js/app.js",
  "./js/compose.js",
  "./js/leads.js",
  "./js/themes.js",
  "./manifest.webmanifest",
  "./assets/logo-gold.png",
  "./assets/logo-white.png",
  "./assets/logo.png",
  "./assets/candle.png",
  "./assets/grain.png",
  "./assets/apple-touch-icon.png",
  "./assets/demo-guest.jpg",
  "./assets/themes/winter-fireside.jpg",
  "./assets/themes/mykonos.jpg",
  "./assets/themes/autumn-orchard.jpg",
  "./assets/themes/winter-woods.jpg",
  "./assets/themes/champagne-night.jpg",
  "./assets/themes/holiday-hearth.jpg",
  "./assets/samples/winter-fireside.jpg",
  "./assets/samples/mykonos.jpg",
  "./assets/samples/autumn.jpg",
  "./assets/samples/winter-woods.jpg",
  "./assets/samples/champagne.jpg",
  "./assets/samples/holiday.jpg",
  "./assets/props/beanie.png",
  "./assets/props/scarf.png",
  "./assets/props/sunglasses.png",
  "./assets/props/sunhat.png",
  "./assets/props/autumn-scarf.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
