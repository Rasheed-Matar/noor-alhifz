const CACHE = 'noor-v-20260627-2140';

// كل ملفات واجهة التطبيق التي يجب أن تعمل بدون إنترنت
const ASSETS = [
  './',
  './index.html',
  './login.html',
  './teacher.html',
  './supervisor.html',
  './examiner.html',
  './manifest.json',
  './icon.svg',
  './pwa.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://fonts.googleapis.com/css2?family=Amiri:wght@400;700&family=Tajawal:wght@300;400;500;700&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      Promise.all(ASSETS.map(a => c.add(a).catch(() => {}))) // تجاهل أي ملف يفشل تنزيله دون إيقاف باقي التثبيت
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

// روابط فايرستور/المصادقة الحيّة: لا نتدخل فيها أبداً
// مكتبة Firebase نفسها تتولى تخزين البيانات محلياً وإعادة المزامنة عند رجوع الإنترنت
const LIVE_API = /(^|\.)firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|firebaseinstallations\.googleapis\.com|firebaselogging-pa\.googleapis\.com/;

self.addEventListener('fetch', e => {
  const req = e.request;

  // فقط طلبات GET قابلة للتخزين المؤقت؛ نترك الباقي (مثل كتابة البيانات) يمر مباشرة للشبكة
  if (req.method !== 'GET') return;
  if (LIVE_API.test(req.url)) return;

  const isHTML = req.mode === 'navigate' || req.url.endsWith('.html') || req.url.endsWith('/');

  if (isHTML) {
    // شبكة أولاً لصفحات HTML (login/teacher/supervisor/examiner..)
    // لضمان وصول أي تحديث فوراً للجهاز، مع رجوع للنسخة المخزّنة فقط عند انعدام الإنترنت
    e.respondWith(
      fetch(req).then(res => {
        const resClone = res.clone();
        caches.open(CACHE).then(c => c.put(req, resClone));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('./login.html')))
    );
    return;
  }

  // باقي الملفات (مانيفست، أيقونات، خطوط، مكتبة فايربيز..):
  // النسخة المخزّنة أولاً للسرعة وعمل التطبيق بدون إنترنت، وإلا الشبكة مع تخزين النتيجة لاستخدامها لاحقاً بدون اتصال
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.status === 200) {
          const resClone = res.clone();
          caches.open(CACHE).then(c => c.put(req, resClone));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

self.addEventListener('message', e => { if (e.data === 'SKIP_WAITING') self.skipWaiting(); });
