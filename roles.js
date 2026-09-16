/* ══════════════════════════════════════════════════════════════
   roles.js — طبقة الصلاحيات المتعددة (Multi-Role) لنور الحفظ
   يوضع بجانب login.html ويُستدعى قبل أي كود مصادقة في كل صفحة:
   <script src="roles.js"></script>
   ══════════════════════════════════════════════════════════════ */
(function (w) {
  'use strict';

  const PAGES = {
    admin:           'supervisor.html',
    fieldSupervisor: 'field-supervisor.html',
    examiner:        'examiner.html',
    teacher:         'teacher.html',
    student:         'student.html'
  };

  const LABELS = {
    admin:           'مشرف',
    fieldSupervisor: 'مشرف ميداني',
    examiner:        'مختبر جودة',
    teacher:         'محفّظ',
    student:         'طالب'
  };

  const ICONS = {
    admin: '🛡️', fieldSupervisor: '🧭', examiner: '📋', teacher: '📖', student: '🎓'
  };

  // ترتيب العرض في نافذة الاختيار
  const ORDER = ['admin', 'fieldSupervisor', 'examiner', 'teacher', 'student'];

  /* ── 1) قراءة الأدوار من مستند المستخدم (متوافق مع الحقل القديم role) ── */
  function getRoles(d) {
    if (!d) return [];
    let list = Array.isArray(d.roles) && d.roles.length ? d.roles.slice() : (d.role ? [d.role] : []);
    // إزالة المكرر + الأدوار غير المعروفة + الترتيب
    list = list.filter((r, i) => PAGES[r] && list.indexOf(r) === i);
    list.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return list;
  }

  function isApproved(d, role) {
    if (!d) return false;
    if (role === 'admin') return true;                       // المشرف العام لا يحتاج اعتماد
    if (d.roleStatus && d.roleStatus[role]) return d.roleStatus[role] === 'approved';
    return d.status === 'approved';
  }

  // الأدوار المتاحة فعلياً للدخول
  function activeRoles(d) { return getRoles(d).filter(r => isApproved(d, r)); }

  function hasRole(d, role) { return activeRoles(d).indexOf(role) !== -1; }

  function pageOf(role) { return PAGES[role] || 'login.html'; }
  function labelOf(role) { return LABELS[role] || role; }

  /* ── 2) الدور الحالي المختار في هذه الجلسة ── */
  const KEY = 'activeRole';
  function getActive() { try { return sessionStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function setActive(r) { try { sessionStorage.setItem(KEY, r); } catch (e) {} }
  function clearActive() { try { sessionStorage.removeItem(KEY); } catch (e) {} }

  /* ── 3) حارس الصفحة: يُستدعى في كل صفحة دور ──
     يرجع {ok:true} أو {ok:false, redirect:'...'}  */
  function guardPage(pageRole, d) {
    const roles = activeRoles(d);
    if (!roles.length) return { ok: false, redirect: 'login.html' };

    if (roles.indexOf(pageRole) !== -1) {   // يملك صلاحية هذه الصفحة → ادخل
      setActive(pageRole);
      return { ok: true };
    }
    // لا يملكها: أعِده لصفحة دوره الحالي إن وُجد، وإلا لدوره الأول
    const target = (getActive() && roles.indexOf(getActive()) !== -1) ? getActive() : roles[0];
    return { ok: false, redirect: pageOf(target) };
  }

  /* ── 4) توجيه ما بعد تسجيل الدخول ── */
  function routeAfterLogin(d, navigate) {
    const roles = activeRoles(d);
    const go = navigate || function (u) { w.location.href = u; };
    if (!roles.length) return false;                 // لا صلاحية → اترك الصفحة تعرض "بانتظار الاعتماد"
    if (roles.length === 1) { setActive(roles[0]); go(pageOf(roles[0])); return true; }
    showPicker(roles, { name: d.name, navigate: go });   // أكثر من صلاحية → نافذة الاختيار
    return true;
  }

  /* ── 5) نافذة اختيار الصلاحية (تعمل في أي صفحة) ── */
  function showPicker(roles, opts) {
    opts = opts || {};
    const go = opts.navigate || function (u) { w.location.href = u; };
    const old = document.getElementById('noorRolePicker');
    if (old) old.remove();

    const wrap = document.createElement('div');
    wrap.id = 'noorRolePicker';
    wrap.dir = 'rtl';
    wrap.innerHTML =
      '<style>' +
      '#noorRolePicker{position:fixed;inset:0;z-index:99999;background:rgba(8,28,24,.75);' +
      'backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;' +
      'font-family:Tajawal,system-ui,sans-serif;animation:nrpFade .25s ease}' +
      '@keyframes nrpFade{from{opacity:0}to{opacity:1}}' +
      '@keyframes nrpUp{from{opacity:0;transform:translateY(22px) scale(.96)}to{opacity:1;transform:none}}' +
      '#noorRolePicker .nrp-card{background:#fff;border-radius:22px;max-width:430px;width:100%;' +
      'padding:26px 22px;box-shadow:0 22px 60px rgba(0,0,0,.35);animation:nrpUp .3s ease}' +
      '#noorRolePicker h3{margin:0 0 4px;font-size:1.25rem;color:#0f5132;text-align:center;font-weight:700}' +
      '#noorRolePicker p{margin:0 0 18px;font-size:.9rem;color:#6b7280;text-align:center}' +
      '#noorRolePicker button.nrp-item{display:flex;align-items:center;gap:12px;width:100%;margin-bottom:10px;' +
      'padding:14px 16px;border:1.5px solid #e3ece7;border-radius:15px;background:#f8fbf9;cursor:pointer;' +
      'font-family:inherit;font-size:1.02rem;font-weight:600;color:#14432f;text-align:right;transition:.18s}' +
      '#noorRolePicker button.nrp-item:hover{border-color:#1f7a5c;background:#eef7f2;transform:translateY(-2px)}' +
      '#noorRolePicker .nrp-ic{width:42px;height:42px;border-radius:12px;background:#1f7a5c;color:#fff;' +
      'display:flex;align-items:center;justify-content:center;font-size:1.25rem;flex:none}' +
      '#noorRolePicker .nrp-ar{margin-inline-start:auto;color:#9aa8a1;font-size:1.1rem}' +
      '#noorRolePicker .nrp-out{width:100%;margin-top:6px;padding:11px;border:none;background:none;' +
      'color:#b91c1c;font-family:inherit;font-size:.9rem;cursor:pointer}' +
      '</style>' +
      '<div class="nrp-card">' +
      '<h3>' + (opts.name ? 'مرحباً ' + esc(opts.name) : 'اختر الصلاحية') + '</h3>' +
      '<p>لديك أكثر من صلاحية في النظام، اختر الواجهة التي تريد الدخول إليها</p>' +
      '<div id="nrpList"></div>' +
      (opts.hideLogout ? '<button class="nrp-out" id="nrpCancel">إلغاء</button>'
                       : '<button class="nrp-out" id="nrpLogout">تسجيل الخروج</button>') +
      '</div>';
    document.body.appendChild(wrap);

    const list = wrap.querySelector('#nrpList');
    roles.forEach(r => {
      const b = document.createElement('button');
      b.className = 'nrp-item';
      b.innerHTML = '<span class="nrp-ic">' + (ICONS[r] || '👤') + '</span><span>' + labelOf(r) +
                    '</span><span class="nrp-ar">←</span>';
      b.onclick = () => { setActive(r); go(pageOf(r)); };
      list.appendChild(b);
    });

    const lo = wrap.querySelector('#nrpLogout');
    if (lo) lo.onclick = () => {
      clearActive();
      try { sessionStorage.removeItem('userCache'); } catch (e) {}
      if (w.firebase && firebase.auth) firebase.auth().signOut();
      w.location.href = 'login.html';
    };
    const cx = wrap.querySelector('#nrpCancel');
    if (cx) cx.onclick = () => wrap.remove();
  }

  /* ── 6) زر "تبديل الصلاحية" داخل أي صفحة ── */
  function switchRole(userDoc) {
    const roles = activeRoles(userDoc);
    if (roles.length < 2) return false;
    showPicker(roles, { name: userDoc.name, hideLogout: true });
    return true;
  }

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  w.NoorRoles = {
    PAGES, LABELS, ICONS,
    getRoles, activeRoles, hasRole, isApproved,
    pageOf, labelOf,
    getActive, setActive, clearActive,
    guardPage, routeAfterLogin, showPicker, switchRole
  };
})(window);
