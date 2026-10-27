/* Thali service worker: offline app shell + serves your meal photos from this phone's storage. */
const CACHE = "thali-v2";
const SHELL = ["./", "./index.html", "./shim.js", "./config.js", "./vendor/supabase.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });

function getAsset(id) {
  return new Promise((res, rej) => {
    const r = indexedDB.open("thali");
    r.onupgradeneeded = () => { const d = r.result; ["docs", "assets", "settings", "outbox", "meta"].forEach(s => d.objectStoreNames.contains(s) || d.createObjectStore(s)); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction("assets").objectStore("assets").get(id); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); };
  });
}
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin === location.origin && url.pathname.includes("/assets/")) {
    const id = url.pathname.split("/assets/")[1];
    e.respondWith(getAsset(id).then(v => v ? new Response(v.blob, { headers: { "Content-Type": v.type } }) : new Response("", { status: 404 })).catch(() => new Response("", { status: 404 })));
    return;
  }
  const isFont = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (url.origin !== location.origin && !isFont) return; // AI and sync calls go straight to the network
  // network first (so updates arrive), cache as offline fallback
  e.respondWith(fetch(e.request).then(r => { if (r.ok || r.type === "opaque") { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match("./index.html"))));
});
