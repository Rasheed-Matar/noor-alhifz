// ════════════════════════════════════════
//  مركز الكتاب — تثبيت التطبيق والعمل دون إنترنت
// ════════════════════════════════════════
(function () {
  'use strict';

  // ── تسجيل Service Worker (تخزين الصفحات لتعمل بدون إنترنت) ──
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) {
        console.warn('تعذّر تسجيل Service Worker:', err);
      });
    });
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  var DISMISS_KEY = 'mkAlkitab_installDismissedAt';
  var DISMISS_DAYS = 3;

  function wasDismissedRecently() {
    var t = localStorage.getItem(DISMISS_KEY);
    if (!t) return false;
    return (Date.now() - parseInt(t, 10)) < DISMISS_DAYS * 24 * 60 * 60 * 1000;
  }

  function dismiss(el) {
    localStorage.setItem(DISMISS_KEY, Date.now().toString());
    if (el) {
      el.style.transition = 'opacity .25s, transform .25s';
      el.style.opacity = '0';
      el.style.transform = 'translateY(12px) scale(.95)';
      setTimeout(function () { el.remove(); }, 250);
    }
  }

  function injectStyles() {
    if (document.getElementById('pwaInstallStyles')) return;
    var s = document.createElement('style');
    s.id = 'pwaInstallStyles';
    s.textContent =
      '@keyframes pwaSlideUp{from{opacity:0;transform:translateY(30px) scale(.92)}to{opacity:1;transform:none}}' +
      '#pwaInstallBanner{position:fixed;left:16px;bottom:16px;z-index:99999;display:flex;align-items:center;gap:12px;' +
        'background:rgba(253,250,243,.97);backdrop-filter:blur(20px);border:1.5px solid #d4c89a;border-radius:20px;' +
        'padding:14px 16px 14px 12px;max-width:330px;box-shadow:0 10px 40px rgba(27,107,74,.25),0 1px 0 rgba(255,255,255,.9) inset;' +
        'font-family:"Tajawal",sans-serif;direction:rtl;animation:pwaSlideUp .5s cubic-bezier(.22,.68,0,1.2) both;}' +
      '#pwaInstallBanner .pwa-icon{width:48px;height:48px;border-radius:14px;flex:none;background:#fff;border:1.5px solid #d4c89a;' +
        'overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(27,107,74,.18);}' +
      '#pwaInstallBanner .pwa-icon img{width:100%;height:100%;object-fit:cover;}' +
      '#pwaInstallBanner .pwa-text{flex:1;min-width:0;}' +
      '#pwaInstallBanner .pwa-title{font-weight:700;font-size:14px;color:#0f4a33;line-height:1.3;}' +
      '#pwaInstallBanner .pwa-sub{font-size:11.5px;color:#3d4a3d;margin-top:3px;line-height:1.6;}' +
      '#pwaInstallBanner .pwa-btn-install{margin-top:8px;border:none;border-radius:10px;font-family:"Tajawal",sans-serif;' +
        'font-size:12.5px;font-weight:700;cursor:pointer;padding:7px 16px;white-space:nowrap;color:#fff;' +
        'background:linear-gradient(135deg,#0f4a33 0%,#1a6b4a 55%,#25906a 100%);box-shadow:0 4px 12px rgba(27,107,74,.3);' +
        'transition:transform .15s;}' +
      '#pwaInstallBanner .pwa-btn-install:active{transform:scale(.94);}' +
      '#pwaInstallBanner .pwa-btn-close{position:absolute;top:8px;left:8px;width:22px;height:22px;border-radius:50%;' +
        'background:rgba(0,0,0,.07);color:#3d4a3d;display:flex;align-items:center;justify-content:center;font-size:12px;' +
        'line-height:1;border:none;cursor:pointer;padding:0;}' +
      '@media (max-width:420px){#pwaInstallBanner{left:10px;right:10px;max-width:none;}}';
    document.head.appendChild(s);
  }

  function getLogoSrc() {
    var selectors = ['.logo-img-wrap img', '.tb-logo-ic img', '.nav-logo img'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.src) return el.src;
    }
    return 'icon.svg';
  }

  function buildBanner(subText, withInstallButton) {
    injectStyles();
    var el = document.createElement('div');
    el.id = 'pwaInstallBanner';
    el.innerHTML =
      '<button class="pwa-btn-close" id="pwaCloseBtn" aria-label="إغلاق">✕</button>' +
      '<div class="pwa-icon"><img src="' + getLogoSrc() + '" alt="أيقونة مركز الكتاب"></div>' +
      '<div class="pwa-text">' +
        '<div class="pwa-title">ثبّت مركز الكتاب على جهازك</div>' +
        '<div class="pwa-sub">' + subText + '</div>' +
        (withInstallButton ? '<button class="pwa-btn-install" id="pwaInstallBtn">تثبيت التطبيق</button>' : '') +
      '</div>';
    document.body.appendChild(el);
    document.getElementById('pwaCloseBtn').addEventListener('click', function () { dismiss(el); });
    return el;
  }

  // ── مسار المتصفحات الداعمة لطلب التثبيت التلقائي (Chrome / Edge / أندرويد..) ──
  var deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    if (isStandalone() || wasDismissedRecently() || document.getElementById('pwaInstallBanner')) return;

    var el = buildBanner('استخدمه كبرنامج مستقل على سطح المكتب، حتى بدون إنترنت، مع رفع تلقائي للبيانات عند الاتصال', true);
    document.getElementById('pwaInstallBtn').addEventListener('click', async function () {
      if (!deferredPrompt) return;
      dismiss(el);
      try {
        deferredPrompt.prompt();
        var choice = await deferredPrompt.userChoice;
        if (choice.outcome !== 'accepted') {
          localStorage.setItem(DISMISS_KEY, Date.now().toString());
        } else {
          localStorage.removeItem(DISMISS_KEY);
        }
      } catch (err) {}
      deferredPrompt = null;
    });
  });

  window.addEventListener('appinstalled', function () {
    var el = document.getElementById('pwaInstallBanner');
    if (el) el.remove();
    localStorage.removeItem(DISMISS_KEY);
  });

  // ── آيفون/آيباد: سفاري لا يدعم beforeinstallprompt، فنعرض تعليمات يدوية ──
  function isIosSafari() {
    var ua = window.navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIOS && isSafari;
  }

  if (isIosSafari()) {
    window.addEventListener('load', function () {
      if (isStandalone() || wasDismissedRecently() || document.getElementById('pwaInstallBanner')) return;
      buildBanner('اضغط زر المشاركة 📤 أسفل الشاشة، ثم اختر "إضافة إلى الشاشة الرئيسية"', false);
    });
  }
})();
