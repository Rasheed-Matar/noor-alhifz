// ════════════════════════════════════════════════════════════════
//  استعادة كلمة المرور ذاتياً (بدون تدخّل المشرف)
//  ────────────────────────────────────────────────────────────────
//  يُدخل المستخدم: رقم الهوية + تاريخ الميلاد + رقم الجوال المسجَّل + كلمة مرور جديدة.
//  التحقق يتم هنا في الخادم فقط (Firebase Admin) — لا يُرسل المتصفح أي بيانات تحقق
//  تُقارن محلياً، ولا يُكشف أي شيء عن بيانات الحساب في الردود.
//
//  حمايات:
//   • ردّ موحّد "البيانات غير مطابقة" لكل أنواع الفشل (حساب غير موجود / بيانات ناقصة / خطأ في أي حقل)
//     كي لا يمكن استخدام الصفحة لمعرفة أرقام الهوية المسجَّلة.
//   • قفل مؤقت: 5 محاولات فاشلة لكل رقم هوية، و15 لكل عنوان IP، خلال 30 دقيقة ⇒ قفل 30 دقيقة.
//     العدّادات في مجموعة Firestore اسمها resetAttempts (يكتبها Admin SDK فقط).
//   • حساب المشرف العام (admin) مستثنى تماماً — يستعيد كلمته من لوحته/البريد.
//   • يُرفض أن تكون كلمة المرور الجديدة هي رقم الهوية (كلمة المرور الافتراضية للحسابات الجديدة).
//   • بعد النجاح: إبطال كل الجلسات القديمة + تسجيل pwResetBy:'self'.
// ════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { admin, ensureInit } = require('./_admin-init');

const MAX_FAILS_NID = 5;
const MAX_FAILS_IP = 15;
const WINDOW_MS = 30 * 60 * 1000;
const LOCK_MS = 30 * 60 * 1000;
const GENERIC_FAIL = 'البيانات غير مطابقة لما هو مسجَّل في المركز. تحقق منها، أو أرسل طلباً للمشرف.';
const ALLOWED_ROLES = ['teacher', 'student', 'examiner', 'fieldSupervisor'];

// ── مساعدات المطابقة ──
function digitsOnly(s) {
  // يحوّل الأرقام الهندية (٠-٩) إلى لاتينية ثم يُبقي الأرقام فقط
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, c => String(c.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, c => String(c.charCodeAt(0) - 0x06F0))
    .replace(/\D/g, '');
}
// آخر 9 أرقام: يوحّد 05XXXXXXXX و 9725XXXXXXXX و 5XXXXXXXX
function phoneKey(s) {
  const d = digitsOnly(s);
  return d.length >= 9 ? d.slice(-9) : '';
}
function dobKey(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  const t = (s && typeof s.toDate === 'function') ? s.toDate() : new Date(s);
  if (isNaN(t)) return '';
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function clientIp(req) {
  const xf = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  return String(xf).split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);

// ── عدّادات المحاولات ──
const attemptRef = key => admin.firestore().collection('resetAttempts').doc(key);

async function lockedMinutes(key) {
  const snap = await attemptRef(key).get();
  if (!snap.exists) return 0;
  const lu = snap.data().lockedUntil || 0;
  return lu > Date.now() ? Math.ceil((lu - Date.now()) / 60000) : 0;
}
async function registerFail(key, max) {
  const ref = attemptRef(key);
  await admin.firestore().runTransaction(async tx => {
    const s = await tx.get(ref);
    const now = Date.now();
    let d = s.exists ? s.data() : {};
    let fails = d.fails || 0, start = d.windowStart || now;
    if (now - start > WINDOW_MS) { fails = 0; start = now; }
    fails += 1;
    const upd = { fails, windowStart: start, lastAt: now };
    if (fails >= max) { upd.lockedUntil = now + LOCK_MS; upd.fails = 0; upd.windowStart = now; }
    tx.set(ref, upd, { merge: true });
  });
}
async function clearFails(key) {
  try { await attemptRef(key).delete(); } catch (_) {}
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const initErr = ensureInit();
  if (initErr) {
    console.error('firebase-admin init error:', initErr);
    return res.status(500).json({ error: 'تعذّر الاتصال بالخادم حالياً، حاول لاحقاً أو أرسل طلباً للمشرف' });
  }

  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const nid = digitsOnly(body.nationalId);
    const dobIn = dobKey(body.dob);
    const phoneIn = phoneKey(body.phone);
    const newPassword = String(body.newPassword == null ? '' : body.newPassword);

    // أخطاء إدخال صريحة (لا تكشف شيئاً عن الحسابات)
    if (!/^[0-9]{9}$/.test(nid)) return res.status(400).json({ error: 'رقم الهوية يجب أن يكون 9 أرقام' });
    if (!dobIn) return res.status(400).json({ error: 'أدخل تاريخ الميلاد' });
    if (!phoneIn) return res.status(400).json({ error: 'أدخل رقم الجوال المسجَّل بالحساب' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    if (newPassword.length > 64) return res.status(400).json({ error: 'كلمة المرور طويلة جداً' });
    if (newPassword === nid) return res.status(400).json({ error: 'اختر كلمة مرور مختلفة عن رقم الهوية' });

    // قفل مؤقت (لكل هوية ولكل IP)
    const nidKey = 'nid_' + nid;
    const ipKey = 'ip_' + sha(clientIp(req));
    const [lockN, lockI] = await Promise.all([lockedMinutes(nidKey), lockedMinutes(ipKey)]);
    const lockMin = Math.max(lockN, lockI);
    if (lockMin > 0) {
      return res.status(429).json({ error: `محاولات كثيرة غير صحيحة. حاول بعد ${lockMin} دقيقة، أو أرسل طلباً للمشرف.` });
    }

    // ── تحقق الهوية ──
    let ok = false, targetUid = null;
    try {
      const authUser = await admin.auth().getUserByEmail(nid + '@noor-alhifz.app');
      const snap = await admin.firestore().collection('users').doc(authUser.uid).get();
      if (snap.exists) {
        const d = snap.data() || {};
        const roles = Array.isArray(d.roles) && d.roles.length ? d.roles : [d.role].filter(Boolean);
        const status = d.status || 'approved';
        const allowed = roles.length > 0 && !roles.includes('admin') && roles.some(r => ALLOWED_ROLES.includes(r));
        const nidOk = !d.nationalId || safeEq(digitsOnly(d.nationalId), nid);
        const dobOk = dobKey(d.dob) !== '' && safeEq(dobKey(d.dob), dobIn);
        const phoneOk = phoneKey(d.phone) !== '' && safeEq(phoneKey(d.phone), phoneIn);
        if (allowed && status === 'approved' && nidOk && dobOk && phoneOk) { ok = true; targetUid = authUser.uid; }
      }
    } catch (e) {
      if (e.code !== 'auth/user-not-found') console.error('self-reset lookup error:', e.code || e.message);
      // أي خطأ آخر يُعامل كفشل تحقق (ردّ موحّد)
    }

    if (!ok) {
      await Promise.all([registerFail(nidKey, MAX_FAILS_NID), registerFail(ipKey, MAX_FAILS_IP)]).catch(e => console.error('registerFail', e));
      return res.status(400).json({ error: GENERIC_FAIL });
    }

    await admin.auth().updateUser(targetUid, { password: newPassword });
    await admin.auth().revokeRefreshTokens(targetUid);
    await admin.firestore().collection('users').doc(targetUid).set(
      { firstLogin: false, pwResetAt: admin.firestore.FieldValue.serverTimestamp(), pwResetBy: 'self' },
      { merge: true }
    );
    await clearFails(nidKey);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('self-reset-password error:', e);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع، حاول لاحقاً أو أرسل طلباً للمشرف' });
  }
};
