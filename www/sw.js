const CACHE = 'recettes-app-v2.73';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './update-check.js', './autobackup.js',
  './data/recipes.json', './data/recipes-extra.json', './manifest.webmanifest',
  './img/icon-192.png', './img/icon-512.png',
];
self.addEventListener('install', (e)=> e.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate', (e)=> e.waitUntil(
  caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch', (e)=>{
  const url = new URL(e.request.url);
  // Shell assets : cache-first (mise à jour au prochain démarrage après install)
  if(url.origin === location.origin){
    e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request).then(res=>{
      if(res && res.status===200 && res.type==='basic'){
        const clone=res.clone(); caches.open(CACHE).then(c=>c.put(e.request,clone));
      }
      return res;
    })));
    return;
  }
  // Images cross-origin (og:image recettes) : stale-while-revalidate
  if(e.request.destination==='image'){
    e.respondWith(caches.open(CACHE).then(async c=>{
      const cached=await c.match(e.request);
      const fresh=fetch(e.request).then(r=>{ if(r&&r.ok) c.put(e.request,r.clone()); return r; }).catch(()=>null);
      return cached || await fresh;
    }));
  }
});
