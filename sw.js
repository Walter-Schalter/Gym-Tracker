/* IRONLOG · Service Worker · Build 2.1.0-d1858ee913
   ----------------------------------------------------------------------------
   Aufgabe: Die App startet auch ohne Netz (Studio-Keller) und aktualisiert
   sich selbst, sobald eine neue index.html auf dem Server liegt.

   Grundsätze
   · Die App-Seite wird „stale-while-revalidate“ ausgeliefert: sofort aus dem
     Cache, im Hintergrund wird nach einer neuen Fassung gesehen. Liegt eine
     vor, zeigt die App „Neue Version – Neu starten“.
   · „…/“ und „…/index.html“ sind dieselbe Seite (ein Cache-Eintrag).
   · In den Cache kommt nur, was sich als vollständige IRONLOG-Seite ausweist
     (Kennung <meta name="ironlog-build"> und abschließendes </html>). Fehler-
     seiten, abgebrochene Übertragungen oder WLAN-Anmeldeseiten ersetzen die
     App also nie.
   · Alles, was nicht zur App gehört, bleibt unberührt: fremde Adressen im
     selben Bereich gehen unverändert ans Netz, Caches anderer Seiten auf
     derselben Domain werden nicht angefasst.
   · Liefert der Server unter der App-Adresse dauerhaft eine andere Seite
     (z. B. weil die vorherige Version zurückgespielt wurde), gibt der
     Service Worker seine Kopie auf und überlässt die Adresse dem Server –
     aber erst, wenn sich das nach einigen Minuten bestätigt (eine einzelne
     veraltete Antwort direkt nach einem Upload kostet die Offline-Kopie nicht).
   · Eine ältere sw.js wird erst abgelöst, wenn die eigene Kopie der App
     sicher im Cache liegt – der Offline-Start geht beim Umstieg nie verloren.
   Nutzerdaten (IndexedDB) fasst diese Datei an keiner Stelle an.
   ---------------------------------------------------------------------------- */
'use strict';

const BUILD = '2.1.0-d1858ee913';
const SW_MARK = 'IRONLOG · Service Worker';
const SCOPE = self.registration.scope;                       // z. B. https://name.github.io/gym/
const CACHE = 'ironlog-app:' + new URL(SCOPE).pathname;      // je Installationsort ein eigener Cache
const ROOT_KEY = SCOPE;
const BUILD_HEADER = 'X-Ironlog-Build';
const FOREIGN_CONFIRM_MS = 12 * 60 * 1000;                   // länger als die Cache-Zeit von GitHub Pages (10 min)
/** Merkzettel im eigenen Cache: „unter dieser Adresse wurde eine andere Seite gesehen – seit wann?“ */
const foreignNoteKey = (key) => SCOPE + '__ironlog-sw__/foreign?page=' + encodeURIComponent(key);
const ASSETS = ['manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png']
  .map((path) => new URL(path, SCOPE).href);

const bare = (url) => url.split(/[?#]/)[0];

/** Cache-Schlüssel einer Seite: ohne Query/Hash, „…/index.html“ zählt als „…/“. */
function pageKey(url) {
  const u = new URL(url);
  const path = u.pathname.endsWith('/index.html') ? u.pathname.slice(0, -'index.html'.length) : u.pathname;
  return u.origin + path;
}

/** Build-Kennung einer IRONLOG-Seite ('' = keine IRONLOG-Seite). Reihenfolge und Anführungszeichen der Attribute sind egal. */
function buildOf(text) {
  const tag = /<meta\b[^>]*\bname\s*=\s*["']?ironlog-build(?=["'\s>\/])[^>]*>/i.exec(text.slice(0, 16384));
  const m = tag && /\bcontent\s*=\s*["']?([^"'\s>]+)/i.exec(tag[0]);
  return m ? m[1].replace(/[^\w.+-]/g, '') : '';
}
/** Vollständig übertragen: das schließende </html> steht ganz am Ende (danach höchstens noch Leerraum oder ein Kommentar). */
const isCompleteHtml = (text) => { const i = text.toLowerCase().lastIndexOf('</html>'); return i >= 0 && i >= text.length - 1024; };

/** Seite vom Server holen und einordnen: app | foreign | error | other | offline. */
async function fetchDocument(key, cacheMode) {
  let res;
  try {
    res = await fetch(new Request(key, { cache: cacheMode, credentials: 'same-origin' }));
  } catch (_) {
    return { state: 'offline' };
  }
  if (res.type !== 'basic' || res.redirected) return { state: 'other' };
  if (!res.ok) return { state: 'error', status: res.status };
  let text;
  try { text = await res.text(); } catch (_) { return { state: 'offline' }; }      // Übertragung abgebrochen
  if (!/html/i.test(res.headers.get('Content-Type') || '') || !isCompleteHtml(text)) return { state: 'other' };
  const build = buildOf(text);
  return build ? { state: 'app', text, build } : { state: 'foreign' };
}

async function notifyUpdate(key) {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    let same = false;
    try { same = pageKey(client.url) === key; } catch (_) { /* ungewöhnliche Adresse */ }
    if (same) client.postMessage({ type: 'UPDATE_READY' });
  }
}

/** Sich vollständig zurückziehen: eigener Cache weg, Abmeldung. (Ruft eine Seite danach erneut
    register('./sw.js') auf, bleibt die Anmeldung bestehen – dann reicht diese Datei nur noch durch.) */
async function retire() {
  try { await caches.delete(CACHE); } catch (_) { /* nichts zu löschen */ }
  await self.registration.unregister();
}

/**
 * Unter der App-Adresse liegt eine andere, vollständige Seite. Erst merken, und nur wenn es bei einer späteren
 * Prüfung (frühestens nach FOREIGN_CONFIRM_MS) immer noch so ist, die Adresse dem Server überlassen.
 */
async function stepAside(key) {
  if (!(await cachedPage(key))) {
    // Für diese Adresse liegt nichts (mehr) von uns vor. Wurde der Cache schon aufgegeben, Abmeldung nachholen.
    let cacheExists = true;
    try { cacheExists = await caches.has(CACHE); } catch (_) { /* unbekannt → nichts tun */ }
    if (!cacheExists && key === ROOT_KEY) await retire();
    return;
  }
  const cache = await caches.open(CACHE);
  const noteKey = foreignNoteKey(key);
  const note = await cache.match(noteKey);
  const since = note ? Number(await note.text()) : 0;
  const now = Date.now();
  if (!since || !Number.isFinite(since) || since > now) {      // erste Sichtung: nur merken, Kopie behalten
    await cache.put(noteKey, new Response(String(now), { headers: { 'Content-Type': 'text/plain' } }));
    return;
  }
  if (now - since < FOREIGN_CONFIRM_MS) return;                // noch nicht bestätigt

  let res;
  try { res = await fetch(new Request(self.location.href, { cache: 'no-store' })); } catch (_) { return; }
  if (res.status === 404 || res.status === 410) { await retire(); return; }    // auch sw.js wurde entfernt → App wurde ersetzt
  if (!res.ok || res.redirected) return;
  let text = '';
  try { text = await res.text(); } catch (_) { return; }
  if (!text.includes(SW_MARK)) return;
  // sw.js liegt noch auf dem Server, die Seite wurde aber dauerhaft ausgetauscht (z. B. vorherige Version zurückgespielt):
  // eigene Kopie aufgeben und offenen Fenstern anbieten, neu zu laden – sie bekommen dann die Seite des Servers.
  await cache.delete(key);
  await cache.delete(noteKey);
  await notifyUpdate(key);
}

/** Seite neu vom Server holen; bei geänderter IRONLOG-Fassung Cache aktualisieren und offene Fenster informieren. */
async function refreshNow(key, cacheMode) {
  const doc = await fetchDocument(key, cacheMode);
  if (doc.state === 'foreign') { await stepAside(key); return 'foreign'; }
  if (doc.state !== 'app') return doc.state;
  const cache = await caches.open(CACHE);
  const old = await cache.match(key);
  const oldText = old ? await old.text() : null;
  await cache.delete(foreignNoteKey(key));                     // die App-Seite ist (wieder) da → Merkzettel verwerfen
  if (oldText === doc.text) return 'same';
  await cache.put(key, new Response(doc.text, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', [BUILD_HEADER]: doc.build }
  }));
  if (oldText !== null) await notifyUpdate(key);
  return 'updated';
}

const inflight = new Map();
/** Wie refreshNow, aber nie parallel für dieselbe Seite und ohne je einen Fehler nach außen zu geben. */
function refreshPage(key, cacheMode = 'no-cache') {
  let job = inflight.get(key);
  if (!job) {
    job = refreshNow(key, cacheMode).catch(() => 'failed').then((result) => { inflight.delete(key); return result; });
    inflight.set(key, job);
  }
  return job;
}

/** Hinterlegte Seite (oder null). Legt – anders als caches.open – keinen leeren Cache an. */
async function cachedPage(key) {
  try { return (await caches.match(key, { cacheName: CACHE })) || null; } catch (_) { return null; }
}

/* ---------- Installation & Aktivierung -------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE);
      const addAsset = (url) => fetch(new Request(url, { cache: 'reload' }))
        .then((res) => (res.ok && res.type === 'basic' && !res.redirected ? cache.put(url, res) : null))
        .catch(() => null);
      // Start-Seite frisch vom Server (am HTTP-Cache vorbei) – dadurch ist die App direkt nach dem
      // Einspielen offline startfähig, auch wenn gerade noch eine ältere Fassung angezeigt wird.
      await Promise.all([refreshPage(ROOT_KEY, 'reload'), ...ASSETS.map(addAsset)]);
    } catch (_) { /* Cache-Speicher nicht verfügbar: App läuft online weiter */ }
    // Ist noch eine frühere sw.js aktiv, hält sie die App offline startfähig. Sie wird erst abgelöst, wenn die
    // eigene Kopie der Start-Seite sicher im Cache liegt – sonst scheitert diese Installation bewusst und der
    // Browser versucht es beim nächsten Start erneut (z. B. wenn die Verbindung gerade abgerissen ist).
    if (self.registration.active && !(await cachedPage(ROOT_KEY))) throw new Error('Start-Seite noch nicht hinterlegt');
    await self.skipWaiting();
  })());
});

/** Caches früherer Fassungen dieser App entfernen – und nur diese. */
async function dropLegacyCaches() {
  const origin = self.location.origin + '/';
  const startPages = [SCOPE, SCOPE + 'index.html'];
  for (const name of await caches.keys()) {
    if (name === CACHE) continue;
    const cache = await caches.open(name);
    const urls = (await cache.keys()).map((req) => bare(req.url)).filter((url) => url.startsWith(origin));
    const ours = urls.some((url) => startPages.includes(url)) && urls.every((url) => url.startsWith(SCOPE));
    if (ours) await caches.delete(name);
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { await dropLegacyCaches(); } catch (_) { /* aufräumen ist optional */ }
    await self.clients.claim();
  })());
});

/* ---------- Nachrichten der App ------------------------------------------------------
   CLIENT_READY { url, build, check }  – die App meldet sich nach dem Start (und wenn sie
                                         nach längerer Zeit wieder in den Vordergrund kommt)
   PRECACHE_PAGE { url }               – gleiche Bedeutung, von Fassung 2.0 ohne Build-Kennung */
async function clientReady(client, data) {
  const url = typeof data.url === 'string' ? data.url : (client && client.url) || '';
  if (!url.startsWith(SCOPE)) return;
  const key = pageKey(url);
  if (data.check || !(await cachedPage(key))) await refreshPage(key);
  else if (inflight.has(key)) await inflight.get(key);
  if (!client || typeof data.build !== 'string' || !data.build) return;
  const hit = await cachedPage(key);
  const build = hit ? hit.headers.get(BUILD_HEADER) : '';
  // Die App läuft mit einer anderen Fassung als der, die bereits für den nächsten Start bereitliegt
  if (build && build !== data.build) client.postMessage({ type: 'UPDATE_READY' });
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'CLIENT_READY' && data.type !== 'PRECACHE_PAGE') return;
  event.waitUntil(clientReady(event.source, data).catch(() => {}));
});

/* ---------- Anfragen ------------------------------------------------------------------ */
function offlineResponse() {
  return new Response('<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IRONLOG</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#000;color:#f1f4fa;font-family:system-ui,sans-serif;text-align:center;padding:24px"><div><h1 style="font-size:20px">Keine Verbindung</h1><p style="color:#a6b0c2">IRONLOG wurde auf diesem Gerät noch nicht vollständig geladen. Bitte einmal mit Internet öffnen.</p></div></body></html>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function servePage(event) {
  const key = pageKey(event.request.url);
  const hit = await cachedPage(key);
  if (hit) {
    event.waitUntil(refreshPage(key));
    return hit;
  }
  // Keine IRONLOG-Seite hinterlegt: die Anfrage geht unverändert ans Netz (echte Antwort inkl. 404 und Weiterleitungen)
  if (key !== ROOT_KEY) return fetch(event.request);
  let res;
  try { res = await fetch(event.request); } catch (_) { return offlineResponse(); }
  if (res.ok) event.waitUntil(refreshPage(key));              // gleich für den nächsten Offline-Start hinterlegen
  return res;
}

async function serveAsset(event, url) {
  let hit = null;
  try { hit = (await caches.match(url, { cacheName: CACHE, ignoreVary: true })) || null; } catch (_) { /* ohne Cache weiter */ }
  const store = (res) => {
    if (!res.ok || res.type !== 'basic' || res.redirected) return res;
    const copy = res.clone();
    return caches.open(CACHE).then((cache) => cache.put(url, copy)).catch(() => {}).then(() => res);
  };
  if (hit) {
    event.waitUntil(fetch(new Request(url, { cache: 'no-cache' })).then(store).catch(() => {}));
    return hit;
  }
  return fetch(event.request).then(store);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  if (req.mode === 'navigate') { event.respondWith(servePage(event)); return; }
  const url = bare(req.url);
  if (ASSETS.includes(url)) event.respondWith(serveAsset(event, url));
});
