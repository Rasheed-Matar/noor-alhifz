// تهيئة Firebase Admin المشتركة بين دوال /api — الملف يبدأ بـ _ فلا تُعامله Vercel كنقطة نهاية
const admin = require('firebase-admin');

// تهيئة كسولة وآمنة: أي خطأ في متغيرات البيئة يُرجَع كـ JSON (مع ترويسات CORS)
// بدل أن تنهار الدالة ويظهر للمتصفح "Failed to fetch"
let initError = null;
function ensureInit() {
  if (admin.apps.length) { initError = null; return null; }
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
  return initError;
}

module.exports = { admin, ensureInit };
