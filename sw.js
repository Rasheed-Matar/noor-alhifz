const CACHE = 'noor-v2';
const ASSETS = ['./', './login.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// شبكة أولاً لكل صفحات HTML (login/teacher/supervisor/examiner..)
// لضمان وصول أي تحديث فوراً للجهاز، مع رجوع للنسخة المخزّنة فقط عند انعدام الإنترنت
self.addEventListener('fetch', e => {
  const url = e.request.url;
  const isHTML = e.request.mode === 'navigate' || url.endsWith('.html') || url.endsWith('/');

  if (isHTML) {
    e.respondWith(
      fetch(e.request).then(res => {
        const resClone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, resClone));
        return res;
      }).catch(() => caches.match(e.request).then(r => r || caches.match('./login.html')))
    );
    return;
  }

  // الملفات الأخرى (أيقونات، مانيفست..): النسخة المخزّنة أولاً، وإلا الشبكة
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
