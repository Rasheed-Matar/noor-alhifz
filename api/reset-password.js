const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FB_PROJECT_ID,
      clientEmail: process.env.FB_CLIENT_EMAIL,
      privateKey: (process.env.FB_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}

// عدّل هذه القائمة لتطابق نطاق موقعك فقط
const ORIGINS = [
  'https://rasheed-matar.github.io',
  'http://localhost:5500',
  'http://127.0.0.1:5500'
];

module.exports = async (req, res) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { idToken, nationalId, newPassword } = req.body || {};

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
