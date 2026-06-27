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

  function getLogoSrc() {
    var selectors = ['.logo-img-wrap img', '.tb-logo-ic img', '.nav-logo img'];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el && el.src) return el.src;
    }
    return 'icon.svg';
  }

  function isIosSafari() {
    var ua = window.navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return isIOS && isSafari;
  }

  // ── الأنماط (شاشة تثبيت كاملة بألوان مركز الكتاب: أخضر زمردي + ذهبي) ──
  function injectStyles() {
    if (document.getElementById('pwaInstallStyles')) return;
    var s = document.createElement('style');
    s.id = 'pwaInstallStyles';
    s.textContent =
      '@keyframes pwaFadeIn{from{opacity:0}to{opacity:1}}' +
      '@keyframes pwaPopIn{from{opacity:0;transform:translateY(26px) scale(.95)}to{opacity:1;transform:none}}' +
      '#pwaInstallOverlay{position:fixed;inset:0;z-index:999999;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;padding:36px 24px;text-align:center;direction:rtl;font-family:"Tajawal",sans-serif;' +
        'background:radial-gradient(ellipse 60% 45% at 50% 4%,rgba(201,168,76,.20) 0%,transparent 62%),' +
        'linear-gradient(165deg,#155a3d 0%,#0f4a33 32%,#0a3326 70%,#06231a 100%);' +
        'animation:pwaFadeIn .35s ease both;overflow-y:auto;}' +
      '#pwaInstallOverlay .pwa-card{display:flex;flex-direction:column;align-items:center;width:100%;max-width:360px;' +
        'animation:pwaPopIn .55s cubic-bezier(.22,.68,0,1.2) .05s both;}' +
      '#pwaInstallOverlay .pwa-icon-wrap{width:104px;height:104px;border-radius:28px;flex:none;' +
        'background:linear-gradient(135deg,#c9a84c 0%,#e8c96a 100%);display:flex;align-items:center;justify-content:center;' +
        'box-shadow:0 0 55px rgba(201,168,76,.45),0 16px 30px rgba(0,0,0,.35);margin-bottom:22px;}' +
      '#pwaInstallOverlay .pwa-icon-circle{width:78px;height:78px;border-radius:50%;background:#fff;overflow:hidden;' +
        'display:flex;align-items:center;justify-content:center;border:2px solid rgba(255,255,255,.65);}' +
      '#pwaInstallOverlay .pwa-icon-circle img{width:100%;height:100%;object-fit:cover;}' +
      '#pwaInstallOverlay .pwa-title{font-family:"Amiri",serif;font-weight:700;font-size:26px;color:#fff;line-height:1.3;}' +
      '#pwaInstallOverlay .pwa-sub{font-size:13.5px;color:rgba(255,255,255,.72);margin-top:11px;line-height:1.95;max-width:300px;}' +
      '#pwaInstallOverlay .pwa-cards{width:100%;display:flex;flex-direction:column;gap:12px;margin-top:30px;}' +
      '#pwaInstallOverlay .pwa-info-card{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.15);' +
        'border-radius:17px;padding:13px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;}' +
      '#pwaInstallOverlay .pwa-info-text{text-align:right;}' +
      '#pwaInstallOverlay .pwa-info-title{font-size:13.5px;font-weight:700;color:#fff;}' +
      '#pwaInstallOverlay .pwa-info-sub{font-size:11px;color:rgba(255,255,255,.55);margin-top:3px;line-height:1.7;}' +
      '#pwaInstallOverlay .pwa-info-icon{width:42px;height:42px;border-radius:13px;flex:none;background:rgba(255,255,255,.1);' +
        'display:flex;align-items:center;justify-content:center;}' +
      '#pwaInstallOverlay .pwa-info-icon svg{width:22px;height:22px;}' +
      '#pwaInstallOverlay .pwa-install-btn{width:100%;margin-top:28px;padding:16px;border:none;border-radius:16px;cursor:pointer;' +
        'background:linear-gradient(135deg,#c9a84c 0%,#e8c96a 100%);color:#0f4a33;font-family:"Tajawal",sans-serif;' +
        'font-size:15.5px;font-weight:800;display:flex;align-items:center;justify-content:center;gap:8px;' +
        'box-shadow:0 10px 28px rgba(201,168,76,.4);transition:transform .15s;}' +
      '#pwaInstallOverlay .pwa-install-btn:active{transform:scale(.96);}' +
      '#pwaInstallOverlay .pwa-skip-btn{margin-top:16px;background:none;border:none;cursor:pointer;' +
        'font-family:"Tajawal",sans-serif;font-size:13px;color:rgba(255,255,255,.55);padding:6px 10px;}' +
      '#pwaInstallOverlay .pwa-skip-btn:hover{color:rgba(255,255,255,.88);text-decoration:underline;}';
    document.head.appendChild(s);
  }

  var PHONE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#e8c96a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><line x1="11" y1="18" x2="13" y2="18"/></svg>';
  var LAPTOP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="#e8c96a" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M2 19h20"/></svg>';

  function dismissOverlay(el) {
    document.body.style.overflow = '';
    if (el) {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 250);
    }
  }

  function showInstallOverlay(deferredPrompt) {
    if (isStandalone() || document.getElementById('pwaInstallOverlay')) return;
    if (sessionStorage.getItem('pwaInstallDismissed') === '1') return;
    injectStyles();

    var mobileSub = isIosSafari()
      ? '"إضافة إلى الشاشة الرئيسية" ← زر المشاركة 📤 ← Safari'
      : '"إضافة إلى الشاشة الرئيسية" ← القائمة ⋮ ← Chrome';

    var el = document.createElement('div');
    el.id = 'pwaInstallOverlay';
    el.innerHTML =
      '<div class="pwa-card">' +
        '<div class="pwa-icon-wrap"><div class="pwa-icon-circle"><img src="' + getLogoSrc() + '" alt="شعار مركز الكتاب"></div></div>' +
        '<div class="pwa-title">مركز الكتاب</div>' +
        '<div class="pwa-sub">ثبّت التطبيق على جهازك للوصول السريع، حتى بدون إنترنت، مع مزامنة تلقائية للبيانات عند الاتصال</div>' +
        '<div class="pwa-cards">' +
          '<div class="pwa-info-card">' +
            '<div class="pwa-info-text"><div class="pwa-info-title">على الجوال</div><div class="pwa-info-sub">' + mobileSub + '</div></div>' +
            '<div class="pwa-info-icon">' + PHONE_SVG + '</div>' +
          '</div>' +
          '<div class="pwa-info-card">' +
            '<div class="pwa-info-text"><div class="pwa-info-title">على الكمبيوتر</div><div class="pwa-info-sub">أيقونة ⊕ في شريط العنوان ← Chrome</div></div>' +
            '<div class="pwa-info-icon">' + LAPTOP_SVG + '</div>' +
          '</div>' +
        '</div>' +
        (deferredPrompt ? '<button class="pwa-install-btn" id="pwaInstallBtn">تثبيت التطبيق الآن ⬇️</button>' : '') +
        '<button class="pwa-skip-btn" id="pwaSkipBtn">متابعة بدون تثبيت</button>' +
      '</div>';

    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';

    document.getElementById('pwaSkipBtn').addEventListener('click', function () {
      sessionStorage.setItem('pwaInstallDismissed', '1');
      dismissOverlay(el);
    });

    if (deferredPrompt) {
      document.getElementById('pwaInstallBtn').addEventListener('click', async function () {
        try {
          deferredPrompt.prompt();
          await deferredPrompt.userChoice;
        } catch (err) {}
        dismissOverlay(el);
      });
    }

    function onKey(e) {
      if (e.key === 'Escape') { sessionStorage.setItem('pwaInstallDismissed', '1'); dismissOverlay(el); document.removeEventListener('keydown', onKey); }
    }
    document.addEventListener('keydown', onKey);
  }

  // ── مسار المتصفحات الداعمة لطلب التثبيت التلقائي (Chrome / Edge / أندرويد..) ──
  var deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    showInstallOverlay(deferredPrompt);
  });

  window.addEventListener('appinstalled', function () {
    var el = document.getElementById('pwaInstallOverlay');
    if (el) dismissOverlay(el);
  });

  // ── آيفون/آيباد: سفاري لا يدعم beforeinstallprompt، فنعرض الشاشة بتعليمات يدوية فقط ──
  if (isIosSafari()) {
    window.addEventListener('load', function () { showInstallOverlay(null); });
  }
})();
