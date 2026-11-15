// ════════════════════════════════════════════════════════════════
//  user-admin — عمليات حسابات/بيانات المستخدمين التي تحتاج صلاحيات Firebase Admin
//  ────────────────────────────────────────────────────────────────
//  POST { idToken, action, ...params }
//
//  الإجراءات:
//   • syncStudent   {teacherId, studentId}  بعد تعديل بيانات طالب: يطابق وثيقة دخوله وبريد Auth (عند تغيّر الهوية)
//                                           ويحدّث الاسم المنسوخ في نتائج الاختبارات والشهادات وترشيحات المحفّظ.
//   • syncTeacher   {teacherId}             بعد تعديل محفّظ: يطابق الاسم/الحلقة المنسوخَين في نتائج الاختبارات والشهادات
//                                           ووثائق طلابه، وبريد Auth عند تغيّر الهوية.
//   • deleteStudent {teacherId, studentId, requestId?}   حذف كامل: القائمة + الحساب (Auth + users) + الجلسات + الحضور
//                                           + التقييم + الواجبات + الرسائل. (نتائج الاختبارات والشهادات تبقى كسجل تاريخي)
//   • releaseNid    {nationalId}            يحرّر رقم هوية محجوزاً بحساب طالب يتيم (حُذف الطالب سابقاً) كي يمكن إعادة إضافته.
//   • cleanupOrphans{dryRun}                (مدير المركز فقط) يفحص/يحذف كل حسابات الطلاب اليتيمة المتراكمة.
//
//  الصلاحيات: يُتحقَّق منها دائماً في الخادم من وثيقة المتّصل في users — لا يُوثَق بأي شيء يرسله المتصفح سوى المعرّفات.
//  المزامنة تقرأ "المصدر الصحيح" من Firestore (لا تستقبل قيماً من المتصفح) فلا يمكن استخدامها لحقن بيانات.
// ════════════════════════════════════════════════════════════════
const { admin, ensureInit } = require('./_admin-init');

const EMAIL_SUFFIX = '@noor-alhifz.app';
const ID_RE = /^[A-Za-z0-9_\-]{1,80}$/;
const NID_RE = /^[0-9]{9}$/;
const BUDGET_MS = 40000;

const db = () => admin.firestore();
const FV = () => admin.firestore.FieldValue;
const httpErr = (status, message) => Object.assign(new Error(message), { status });

// ── الأدوار (مطابقة لمنطق roles.js) ──
function rolesOf(d) {
  const list = Array.isArray(d && d.roles) && d.roles.length ? d.roles.slice() : (d && d.role ? [d.role] : []);
  return list.filter((r, i) => list.indexOf(r) === i);
}
function approvedRole(d, role) {
  if (role === 'admin') return true;
  if (d.roleStatus && d.roleStatus[role]) return d.roleStatus[role] === 'approved';
  return d.status === 'approved';
}

async function authenticate(req, body) {
  const header = (req.headers && req.headers.authorization) || '';
  const token = body.idToken || header.replace(/^Bearer\s+/i, '');
  if (!token) throw httpErr(401, 'غير مصرّح: سجّل الدخول أولاً');
  let dec;
  try { dec = await admin.auth().verifyIdToken(token); }
  catch (_) { throw httpErr(401, 'انتهت الجلسة، أعد تسجيل الدخول ثم حاول مجدداً'); }
  const snap = await db().collection('users').doc(dec.uid).get();
  if (!snap.exists) throw httpErr(403, 'حساب غير موجود');
  const data = snap.data() || {};
  const roles = rolesOf(data).filter(r => approvedRole(data, r));
  return { uid: dec.uid, data, roles, isAdmin: roles.includes('admin'), isFs: roles.includes('fieldSupervisor') };
}

async function teacherDoc(tid) {
  const snap = await db().collection('userdata').doc(tid).get();
  return snap.exists ? (snap.data() || {}) : null;
}
// هل يملك المتّصل إدارة هذا المحفّظ؟ (مدير المركز، أو المشرف الميداني المسؤول عنه، أو المحفّظ نفسه إن سُمح)
async function assertCanManageTeacher(caller, tid, { allowSelf }) {
  if (caller.isAdmin) return;
  if (allowSelf && caller.uid === tid) return;
  if (caller.isFs) {
    const td = await teacherDoc(tid);
    if (td && td.fieldSupervisorId === caller.uid) return;
  }
  throw httpErr(403, 'ليست لديك صلاحية على هذا المحفّظ');
}

// ── مساعدات الكتابة ──
async function commitOps(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db().batch();
    ops.slice(i, i + 400).forEach(fn => fn(batch));
    await batch.commit();
  }
}
async function deleteAuthUser(uid) {
  try { await admin.auth().deleteUser(uid); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
}
async function deleteMessagesOf(uid) {
  let n = 0;
  for (const field of ['fromId', 'toId']) {
    const snap = await db().collection('appMessages').where(field, '==', uid).get();
    n += snap.size;
    await commitOps(snap.docs.map(d => b => b.delete(d.ref)));
  }
  return n;
}

// ── مطابقة بريد Auth مع رقم الهوية (اسم الدخول = رقم الهوية@noor-alhifz.app) ──
async function syncAuthEmail(uid, nid) {
  if (!NID_RE.test(String(nid || ''))) return { skipped: 'bad-nid' };
  let au;
  try { au = await admin.auth().getUser(uid); }
  catch (e) { if (e.code === 'auth/user-not-found') return { skipped: 'no-auth' }; throw e; }
  if (!au.email || !au.email.endsWith(EMAIL_SUFFIX)) return { skipped: 'custom-email' };
  const want = nid + EMAIL_SUFFIX;
  if (au.email === want) return { unchanged: true };
  try {
    await admin.auth().updateUser(uid, { email: want });
    return { updated: true };
  } catch (e) {
    if (e.code !== 'auth/email-already-exists') throw e;
    // البريد المطلوب محجوز: إن كان حساباً يتيماً لطالب محذوف نحرّره ثم نكرّر
    const rel = await releaseNidInternal(nid, uid);
    if (!rel.released) return { conflict: true, reason: rel.reason };
    await admin.auth().updateUser(uid, { email: want });
    return { updated: true, releasedOrphan: true };
  }
}

// ════════════════════════════════════════════════════════════════
//  syncStudent
// ════════════════════════════════════════════════════════════════
async function actSyncStudent(caller, { teacherId, studentId }) {
  if (!ID_RE.test(teacherId || '') || !ID_RE.test(studentId || '')) throw httpErr(400, 'معرّفات غير صالحة');
  await assertCanManageTeacher(caller, teacherId, { allowSelf: true });
  const td = await teacherDoc(teacherId);
  const st = td && (td.students || []).find(s => s.id === studentId);
  if (!st) throw httpErr(404, 'الطالب غير موجود في قائمة المحفّظ');
  const tUser = await db().collection('users').doc(teacherId).get();
  const circle = (tUser.exists && tUser.data().circle) || 'حلقة القرآن';
  const out = { usersUpdated: 0, authEmail: null, examResults: 0, certificates: 0, nominations: 0 };

  // 1) وثيقة/وثائق دخول الطالب ← من سجل الطالب (المصدر الصحيح)
  const want = {
    name: st.name || '', firstName: st.firstName || '', fatherName: st.fatherName || '',
    grandfatherName: st.grandfatherName || '', familyName: st.familyName || '',
    nationalId: st.nationalId || '', phone: st.parentPhone || '',
    dob: st.dob || '', placeOfBirth: st.placeOfBirth || '', gender: st.gender || '', circle
  };
  const us = await db().collection('users').where('studentId', '==', studentId).get();
  for (const doc of us.docs) {
    const d = doc.data();
    if (d.teacherId && d.teacherId !== teacherId) continue;
    const diff = {};
    Object.keys(want).forEach(k => { if ((d[k] || '') !== want[k]) diff[k] = want[k]; });
    if (Object.keys(diff).length) { await doc.ref.update(diff); out.usersUpdated++; }
    if (rolesOf(d).includes('student') && NID_RE.test(want.nationalId)) {
      out.authEmail = await syncAuthEmail(doc.id, want.nationalId);
    }
  }

  // 2) نتائج الاختبارات
  const ex = await db().collection('examResults').where('studentId', '==', studentId).get();
  const exOps = ex.docs.filter(d => d.data().studentName !== want.name).map(d => b => b.update(d.ref, { studentName: want.name }));
  await commitOps(exOps); out.examResults = exOps.length;

  // 3) الشهادات (الحقول الموجودة فقط)
  const ce = await db().collection('certificates').where('studentId', '==', studentId).get();
  const ceOps = [];
  ce.docs.forEach(d => {
    const c = d.data(), diff = {};
    if (c.studentName !== want.name) diff.studentName = want.name;
    if ('nationalId' in c && c.nationalId !== want.nationalId) diff.nationalId = want.nationalId;
    if ('dob' in c && c.dob !== want.dob) diff.dob = want.dob;
    if ('placeOfBirth' in c && c.placeOfBirth !== want.placeOfBirth) diff.placeOfBirth = want.placeOfBirth;
    if (Object.keys(diff).length) ceOps.push(b => b.update(d.ref, diff));
  });
  await commitOps(ceOps); out.certificates = ceOps.length;

  // 4) ترشيحات الاختبار داخل وثيقة المحفّظ (اسم الطالب منسوخ فيها)
  const tRef = db().collection('userdata').doc(teacherId);
  await db().runTransaction(async tx => {
    const snap = await tx.get(tRef);
    if (!snap.exists) return;
    const exams = snap.data().exams || [];
    if (!exams.some(e => e.studentId === studentId && e.studentName !== want.name)) return;
    out.nominations = exams.filter(e => e.studentId === studentId && e.studentName !== want.name).length;
    tx.update(tRef, { exams: exams.map(e => e.studentId === studentId ? { ...e, studentName: want.name } : e) });
  });
  return out;
}

// ════════════════════════════════════════════════════════════════
//  syncTeacher
// ════════════════════════════════════════════════════════════════
async function actSyncTeacher(caller, { teacherId }) {
  if (!ID_RE.test(teacherId || '')) throw httpErr(400, 'معرّف غير صالح');
  await assertCanManageTeacher(caller, teacherId, { allowSelf: true });
  const tu = await db().collection('users').doc(teacherId).get();
  if (!tu.exists) throw httpErr(404, 'المحفّظ غير موجود');
  const t = tu.data();
  const name = t.name || '', circle = t.circle || 'حلقة القرآن';
  const out = { examResults: 0, certificates: 0, studentAccounts: 0, authEmail: null };

  const ex = await db().collection('examResults').where('teacherId', '==', teacherId).get();
  const exOps = ex.docs.filter(d => d.data().teacherName !== name).map(d => b => b.update(d.ref, { teacherName: name }));
  await commitOps(exOps); out.examResults = exOps.length;

  const ce = await db().collection('certificates').where('teacherId', '==', teacherId).get();
  const ceOps = ce.docs.filter(d => d.data().teacherName !== name).map(d => b => b.update(d.ref, { teacherName: name }));
  await commitOps(ceOps); out.certificates = ceOps.length;

  // وثائق دخول طلابه تحمل نسخة من اسم الحلقة
  const su = await db().collection('users').where('teacherId', '==', teacherId).get();
  const suOps = su.docs.filter(d => rolesOf(d.data()).includes('student') && d.data().circle !== circle)
    .map(d => b => b.update(d.ref, { circle }));
  await commitOps(suOps); out.studentAccounts = suOps.length;

  if (NID_RE.test(String(t.nationalId || ''))) out.authEmail = await syncAuthEmail(teacherId, t.nationalId);
  return out;
}

// ════════════════════════════════════════════════════════════════
//  حذف الطالب
// ════════════════════════════════════════════════════════════════
// إزالة الطالب من وثيقة المحفّظ داخل Transaction. ملاحظة: set(...,{merge:true}) يدمج الخرائط (maps) ولا يحذف مفاتيحها،
// لذلك تُستخدم update مع FieldValue.delete() لمفاتيح الواجبات وفتح الصفحة، وتُستبدل المصفوفات كاملة.
async function removeStudentFromTeacherDoc(tid, sid, requestId) {
  const ref = db().collection('userdata').doc(tid);
  let removed = false;
  await db().runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const d = snap.data(), patch = {};
    if (Array.isArray(d.students)) { patch.students = d.students.filter(s => s.id !== sid); removed = patch.students.length !== d.students.length; }
    if (Array.isArray(d.exams)) patch.exams = d.exams.filter(e => e.studentId !== sid);
    if (Array.isArray(d.evalStudentIds)) patch.evalStudentIds = d.evalStudentIds.filter(x => x !== sid);
    if (d.homework && d.homework[sid] !== undefined) patch['homework.' + sid] = FV().delete();
    if (d.pageOpens && typeof d.pageOpens === 'object') {
      Object.keys(d.pageOpens).forEach(date => {
        const v = d.pageOpens[date];
        if (v && typeof v === 'object' && v[sid] !== undefined) patch['pageOpens.' + date + '.' + sid] = FV().delete();
      });
    }
    if (Array.isArray(d.deletionRequests)) {
      patch.deletionRequests = d.deletionRequests.map(r =>
        ((requestId && r.id === requestId) || (!requestId && r.studentId === sid && r.status === 'pending'))
          ? { ...r, status: 'approved', resolvedAt: new Date().toISOString() } : r);
    }
    tx.update(ref, patch);
  });
  return removed;
}

// حذف بيانات الطالب في المجموعات الفرعية: الجلسات + مفاتيحه في وثائق الحضور والتقييم اليومي
async function purgeStudentSubdata(tid, sid) {
  const ref = db().collection('userdata').doc(tid);
  const out = { sessions: 0, attendanceDays: 0, evalDays: 0 };
  const ss = await ref.collection('sessions').where('studentId', '==', sid).get();
  out.sessions = ss.size;
  await commitOps(ss.docs.map(d => b => b.delete(d.ref)));
  for (const [sub, key] of [['attendance', 'attendanceDays'], ['dailyEval', 'evalDays']]) {
    const snap = await ref.collection(sub).get();
    const ops = snap.docs.filter(d => (d.data() || {})[sid] !== undefined).map(d => b => b.update(d.ref, { [sid]: FV().delete() }));
    out[key] = ops.length;
    await commitOps(ops);
  }
  return out;
}

// حذف حساب/حسابات دخول الطالب (Auth + users) والرسائل المرتبطة. حساب متعدد الأدوار تُسحَب منه صلاحية الطالب فقط.
async function purgeStudentAccounts(tid, sid, nid) {
  const out = { accounts: 0, rolesStripped: 0, authOnly: 0, messages: 0 };
  const seen = new Set();
  const us = await db().collection('users').where('studentId', '==', sid).get();
  for (const doc of us.docs) {
    const d = doc.data();
    if (tid && d.teacherId && d.teacherId !== tid) continue;
    seen.add(doc.id);
    const roles = rolesOf(d);
    if (roles.some(r => r !== 'student')) {
      const rest = roles.filter(r => r !== 'student');
      const upd = { roles: rest, role: rest[0], studentId: FV().delete(), teacherId: FV().delete() };
      if (d.roleStatus && d.roleStatus.student) upd['roleStatus.student'] = FV().delete();
      await doc.ref.update(upd);
      out.rolesStripped++;
    } else {
      await deleteAuthUser(doc.id);
      await doc.ref.delete();
      out.accounts++;
    }
    out.messages += await deleteMessagesOf(doc.id);
  }
  if (NID_RE.test(String(nid || ''))) {
    try {
      const au = await admin.auth().getUserByEmail(nid + EMAIL_SUFFIX);
      if (!seen.has(au.uid)) {
        const other = await db().collection('users').doc(au.uid).get();
        if (!other.exists) { await admin.auth().deleteUser(au.uid); out.authOnly++; }
      }
    } catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  }
  return out;
}

async function actDeleteStudent(caller, { teacherId, studentId, requestId }) {
  if (!ID_RE.test(teacherId || '') || !ID_RE.test(studentId || '')) throw httpErr(400, 'معرّفات غير صالحة');
  if (requestId && !ID_RE.test(requestId)) throw httpErr(400, 'معرّف الطلب غير صالح');
  await assertCanManageTeacher(caller, teacherId, { allowSelf: false });
  const td = await teacherDoc(teacherId);
  if (!td) throw httpErr(404, 'المحفّظ غير موجود');
  const student = (td.students || []).find(s => s.id === studentId);
  const nid = student && student.nationalId;
  const out = { removedFromList: false, warnings: [] };

  // 1) القائمة أولاً (ما يراه المستخدم) ثم التنظيف؛ كل خطوة مستقلة وتُعاد بأمان إن فشلت إحداها (idempotent)
  out.removedFromList = await removeStudentFromTeacherDoc(teacherId, studentId, requestId);
  try { out.subdata = await purgeStudentSubdata(teacherId, studentId); }
  catch (e) { out.warnings.push('تعذّر حذف بعض الجلسات/الحضور: ' + e.message); }
  try { out.accounts = await purgeStudentAccounts(teacherId, studentId, nid); }
  catch (e) { out.warnings.push('تعذّر حذف حساب دخول الطالب: ' + e.message); }
  return out;
}

// ════════════════════════════════════════════════════════════════
//  تحرير رقم هوية محجوز بحساب يتيم
// ════════════════════════════════════════════════════════════════
async function allStudentIds() {
  const snap = await db().collection('userdata').get();
  const ids = new Set();
  snap.docs.forEach(d => (d.data().students || []).forEach(s => s && s.id && ids.add(s.id)));
  return ids;
}
// يتيم = حساب طالب فقط، ومعرّف طالبه غير موجود في أي قائمة محفّظ
async function isOrphanStudentDoc(d, idSetLoader) {
  const roles = rolesOf(d);
  if (roles.length !== 1 || roles[0] !== 'student') return false;
  if (!d.studentId) return false;
  if (d.teacherId) {
    const td = await teacherDoc(d.teacherId);
    if (td && (td.students || []).some(s => s.id === d.studentId)) return false;   // مسار سريع: موجود لدى محفّظه
  }
  const ids = await idSetLoader();                                                  // تأكيد شامل (قد يكون نُقل لمحفّظ آخر)
  return !ids.has(d.studentId);
}

async function releaseNidInternal(nid, exceptUid) {
  if (!NID_RE.test(String(nid || ''))) return { released: false, reason: 'bad-nid' };
  let idsCache = null;
  const loader = async () => idsCache || (idsCache = await allStudentIds());
  let au = null;
  try { au = await admin.auth().getUserByEmail(nid + EMAIL_SUFFIX); }
  catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  if (au && au.uid === exceptUid) return { released: false, reason: 'same-account' };

  if (au) {
    const us = await db().collection('users').doc(au.uid).get();
    if (!us.exists) {
      const age = Date.now() - new Date(au.metadata.creationTime).getTime();
      if (age < 5 * 60 * 1000) return { released: false, reason: 'recent' };       // قد يكون قيد الإنشاء الآن
      await admin.auth().deleteUser(au.uid);
      return { released: true, authOnly: true };
    }
    const d = us.data();
    if (!(await isOrphanStudentDoc(d, loader))) return { released: false, reason: rolesOf(d).includes('student') && rolesOf(d).length === 1 ? 'active-student' : 'other-role' };
    await purgeStudentAccounts(d.teacherId, d.studentId, nid);
    return { released: true, purged: true };
  }
  // لا حساب Auth لكن قد توجد وثائق users بنفس الهوية
  const byNid = await db().collection('users').where('nationalId', '==', nid).get();
  if (byNid.empty) return { released: true, nothing: true };
  for (const doc of byNid.docs) {
    if (!(await isOrphanStudentDoc(doc.data(), loader))) return { released: false, reason: 'active' };
  }
  for (const doc of byNid.docs) { await doc.ref.delete(); }
  return { released: true, docsOnly: true };
}

async function actReleaseNid(caller, { nationalId }) {
  if (!caller.isAdmin && !caller.isFs) throw httpErr(403, 'ليست لديك صلاحية');
  const nid = String(nationalId || '').replace(/\D/g, '');
  if (!NID_RE.test(nid)) throw httpErr(400, 'رقم الهوية يجب أن يكون 9 أرقام');
  return releaseNidInternal(nid, null);
}

// ════════════════════════════════════════════════════════════════
//  تنظيف الحسابات اليتيمة المتراكمة (مدير المركز فقط)
// ════════════════════════════════════════════════════════════════
async function actCleanupOrphans(caller, { dryRun }) {
  if (!caller.isAdmin) throw httpErr(403, 'هذه الأداة لمدير المركز فقط');
  const t0 = Date.now();
  const ids = await allStudentIds();
  const usersSnap = await db().collection('users').get();
  const userIds = new Set(usersSnap.docs.map(d => d.id));
  const orphans = [];
  usersSnap.docs.forEach(doc => {
    const d = doc.data(), roles = rolesOf(d);
    if (roles.length === 1 && roles[0] === 'student' && d.studentId && !ids.has(d.studentId)) {
      orphans.push({ uid: doc.id, name: d.name || '', nationalId: d.nationalId || '', teacherId: d.teacherId || '', studentId: d.studentId });
    }
  });
  // حسابات Auth بلا وثيقة users (أقدم من ساعة، حتى لا نمسّ حساباً قيد الإنشاء)
  const authOnly = [];
  let pageToken;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach(u => {
      if (u.email && u.email.endsWith(EMAIL_SUFFIX) && !userIds.has(u.uid) &&
          Date.now() - new Date(u.metadata.creationTime).getTime() > 60 * 60 * 1000) {
        authOnly.push({ uid: u.uid, email: u.email });
      }
    });
    pageToken = page.pageToken;
  } while (pageToken);

  if (dryRun) return { dryRun: true, orphans, authOnly };

  let done = 0;
  for (const o of orphans) {
    if (Date.now() - t0 > BUDGET_MS) break;
    if (o.teacherId && (await teacherDoc(o.teacherId))) { try { await purgeStudentSubdata(o.teacherId, o.studentId); } catch (_) {} }
    await purgeStudentAccounts(o.teacherId, o.studentId, o.nationalId);
    done++;
  }
  let doneAuth = 0;
  for (const a of authOnly) {
    if (Date.now() - t0 > BUDGET_MS) break;
    await deleteAuthUser(a.uid); doneAuth++;
  }
  return { dryRun: false, purgedAccounts: done, purgedAuthOnly: doneAuth,
           remaining: (orphans.length - done) + (authOnly.length - doneAuth) };
}

// ════════════════════════════════════════════════════════════════
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const initErr = ensureInit();
  if (initErr) {
    console.error('firebase-admin init error:', initErr);
    return res.status(500).json({ error: 'تعذّر الاتصال بالخادم حالياً، حاول لاحقاً' });
  }
  try {
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const caller = await authenticate(req, body);
    const actions = {
      syncStudent: actSyncStudent, syncTeacher: actSyncTeacher, deleteStudent: actDeleteStudent,
      releaseNid: actReleaseNid, cleanupOrphans: actCleanupOrphans
    };
    const fn = actions[body.action];
    if (!fn) throw httpErr(400, 'إجراء غير معروف');
    const result = await fn(caller, body);
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.error('user-admin error:', e);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع: ' + (e.message || '') });
  }
};
