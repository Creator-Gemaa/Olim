const PREFIX='vyra-shell-';const NAME=PREFIX+'v1';
self.addEventListener('install',e=>e.waitUntil(caches.open(NAME).then(c=>c.addAll(['/','/manifest.webmanifest','/icon.svg']))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==NAME).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('message',e=>{if(e.data&&e.data.type==='SKIP_WAITING')self.skipWaiting()});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;if(e.request.mode==='navigate')e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open(NAME).then(cache=>cache.put('/',c));return r}).catch(()=>caches.match('/')))});
