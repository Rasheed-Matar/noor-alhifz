const admin = require('firebase-admin');

// تهيئة Firebase Admin بشكل كسول وآمن: أي خطأ في متغيرات البيئة يُرجَع كـ JSON
// (مع ترويسات CORS) بدل أن تنهار الدالة ويظهر للمتصفح "Failed to fetch"
let initError = null;
function ensureInit() {
  if (admin.apps.length) return;
  try {
    const { FB_PROJECT_ID, FB_CLIENT_EMAIL, FB_PRIVATE_KEY } = process.env;
    if (!FB_PROJECT_ID || !FB_CLIENT_EMAIL || !FB_PRIVATE_KEY) {
      throw new Error('متغيرات البيئة ناقصة في Vercel: FB_PROJECT_ID / FB_CLIENT_EMAIL / FB_PRIVATE_KEY');
    }
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FB_PROJECT_ID,
        clientEmail: FB_CLIENT_EMAIL,
        privateKey: FB_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    initError = null;
  } catch (e) {
    initError = e;
  }
}

module.exports = async (req, res) => {
  // الأمان هنا قائم على التحقق من idToken (وليس على الكوكيز)، لذلك السماح لأي نطاق آمن
  // ويحل مشكلة الدخول من github.io أو نطاق مخصص أو PWA أو localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  ensureInit();
  if (initError) {
    console.error('firebase-admin init error:', initError);
    return res.status(500).json({ error: initError.message || 'فشل تهيئة Firebase Admin' });
  }

  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const { idToken, nationalId, newPassword } = body;

    if (!idToken || !nationalId || !newPassword) {
      return res.status(400).json({ error: 'بيانات ناقصة (idToken / nationalId / newPassword)' });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل' });
    }

    // 1) تحقق من هوية المنادي عبر توكن Firebase — لا تثق أبداً بأي uid يُرسل من المتصفح
    const decoded = await admin.auth().verifyIdToken(idToken, true);

    // 2) تحقق أن المنادي مشرف (admin) فعلياً في Firestore
    const callerSnap = await admin.firestore().collection('users').doc(decoded.uid).get();
    const caller = callerSnap.exists ? callerSnap.data() : null;
    const callerRoles = Array.isArray(caller && caller.roles)
      ? caller.roles
      : [caller && caller.role].filter(Boolean);

    if (!caller || !callerRoles.includes('admin')) {
      return res.status(403).json({ error: 'غير مصرّح لك بتنفيذ هذا الإجراء' });
    }

    // 3) نفّذ إعادة تعيين كلمة المرور على الحساب الهدف
    const email = String(nationalId).trim() + '@noor-alhifz.app';
    const targetUser = await admin.auth().getUserByEmail(email);

    await admin.auth().updateUser(targetUser.uid, { password: String(newPassword) });

    // إبطال كل جلسات الدخول القديمة لهذا الحساب (أمان إضافي)
    await admin.auth().revokeRefreshTokens(targetUser.uid);

    // علامة تُظهر للمستخدم رسالة "غيّر كلمة مرورك" عند دخوله القادم + سجل تدقيق
    await admin.firestore().collection('users').doc(targetUser.uid).set(
      {
        firstLogin: true,
        pwResetAt: admin.firestore.FieldValue.serverTimestamp(),
        pwResetBy: decoded.uid
      },
      { merge: true }
    );

    return res.status(200).json({ ok: true, uid: targetUser.uid });
  } catch (e) {
    const map = {
      'auth/user-not-found': 'لا يوجد حساب مصادقة بهذا الرقم',
      'auth/id-token-expired': 'انتهت صلاحية الجلسة، أعد تسجيل الدخول وحاول مجدداً',
      'auth/id-token-revoked': 'انتهت صلاحية الجلسة، أعد تسجيل الدخول وحاول مجدداً',
      'auth/argument-error': 'رمز الدخول غير صالح'
    };
    console.error('reset-password error:', e);
    return res.status(400).json({ error: map[e.code] || e.message || 'حدث خطأ غير متوقع' });
  }
};
