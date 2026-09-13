// ════════════════════════════════════════════════════════════════
//  نظام المزامنة الاحتياطي في الخلفية (Background Sync) — نور الحفظ
//  ────────────────────────────────────────────────────────────────
//  الهدف: إذا سجّل المحفّظ بيانات وهو بدون إنترنت ثم أغلق الصفحة قبل
//  عودة الاتصال، تُرفع البيانات تلقائياً بمجرد عودة الإنترنت دون أن
//  يحتاج لفتح الصفحة يدوياً.
//
//  آلية العمل: عندما تحدث كتابة وقت انقطاع الاتصال، نُخزّن نسخة خفيفة
//  منها في IndexedDB (بجانب تخزين Firestore الداخلي المعتاد)، ونطلب
//  من نظام التشغيل تنبيهنا عبر Background Sync عند عودة الشبكة. عند
//  ذلك يستيقظ Service Worker (حتى لو كانت الصفحة مغلقة تماماً) ويرسل
//  الكتابات المعلّقة مباشرة عبر Firestore REST API.
//
//  ⚠️ قيد مهم من المتصفح نفسه (وليس من هذا الكود): ميزة Background
//  Sync مدعومة على أندرويد/كروم فقط. آيفون/سفاري لا يدعمها إطلاقاً
//  حتى مع تثبيت التطبيق كـ PWA. على تلك الأجهزة، لا فقدان للبيانات
//  (تبقى محفوظة محلياً في تخزين Firestore كالمعتاد) لكنها تُرفع فقط
//  عند فتح الصفحة يدوياً كما كان الحال سابقاً.
// ════════════════════════════════════════════════════════════════

const SYNC_DB_NAME='noorSyncDB', SYNC_DB_VERSION=1;
const SYNC_TAG='noor-flush-writes';
const FIRESTORE_API_KEY='AIzaSyAJuRiluapshZAego74Pmu-fK5EsT5UhJ0';
const FIRESTORE_PROJECT_ID='noor-alhifz';

function openSyncDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(SYNC_DB_NAME, SYNC_DB_VERSION);
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('authCache')) db.createObjectStore('authCache');
      if(!db.objectStoreNames.contains('pendingWrites')) db.createObjectStore('pendingWrites',{keyPath:'id'});
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function idbGet(store,key){
  return openSyncDB().then(db=>new Promise((resolve,reject)=>{
    const rq=db.transaction(store,'readonly').objectStore(store).get(key);
    rq.onsuccess=()=>resolve(rq.result); rq.onerror=()=>reject(rq.error);
  }));
}
function idbPut(store,value,key){
  return openSyncDB().then(db=>new Promise((resolve,reject)=>{
    const os=db.transaction(store,'readwrite').objectStore(store);
    const rq=key!==undefined?os.put(value,key):os.put(value);
    rq.onsuccess=()=>resolve(); rq.onerror=()=>reject(rq.error);
  }));
}
function idbDelete(store,key){
  return openSyncDB().then(db=>new Promise((resolve,reject)=>{
    const rq=db.transaction(store,'readwrite').objectStore(store).delete(key);
    rq.onsuccess=()=>resolve(); rq.onerror=()=>reject(rq.error);
  }));
}
function idbGetAll(store){
  return openSyncDB().then(db=>new Promise((resolve,reject)=>{
    const rq=db.transaction(store,'readonly').objectStore(store).getAll();
    rq.onsuccess=()=>resolve(rq.result||[]); rq.onerror=()=>reject(rq.error);
  }));
}

// ─── تحويل بيانات JS إلى صيغة Firestore REST، مع بناء مسارات updateMask
//     الطرفية فقط — لمحاكاة سلوك set(data,{merge:true}) (دمج متداخل
//     يُبقي الحقول الشقيقة سليمة، بدل استبدال الكائن بالكامل) ───
function toFirestoreValue(v){
  if(v===null||v===undefined) return {nullValue:null};
  if(typeof v==='boolean') return {booleanValue:v};
  if(typeof v==='number') return Number.isInteger(v)?{integerValue:String(v)}:{doubleValue:v};
  if(typeof v==='string') return {stringValue:v};
  if(Array.isArray(v)) return {arrayValue:{values:v.map(toFirestoreValue)}};
  if(typeof v==='object') return {mapValue:{fields:buildRestFieldsFlat(v)}};
  return {stringValue:String(v)};
}
function buildRestFieldsFlat(obj){
  const fields={};
  Object.keys(obj).forEach(k=>{ fields[k]=toFirestoreValue(obj[k]); });
  return fields;
}
function escapeFieldPathSeg(k){
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : ('`'+String(k).replace(/`/g,'\\`')+'`');
}
function buildRestPatch(obj, prefix){
  const fields={}, maskPaths=[];
  Object.keys(obj).forEach(k=>{
    const v=obj[k];
    const path=prefix?prefix+'.'+escapeFieldPathSeg(k):escapeFieldPathSeg(k);
    if(v && typeof v==='object' && !Array.isArray(v)){
      const nested=buildRestPatch(v, path);
      fields[k]={mapValue:{fields:nested.fields}};
      maskPaths.push(...nested.maskPaths);
    }else{
      fields[k]=toFirestoreValue(v);
      maskPaths.push(path);
    }
  });
  return {fields, maskPaths};
}

// ─── تُستدعى من الصفحة بعد كل تسجيل دخول ناجح — تُخزّن رمز الدخول
//     وseرمز التجديد كي يستطيع الـ Service Worker استخدامهما لاحقاً ───
async function cacheAuthTokens(user){
  if(!user) return;
  try{
    const idToken=await user.getIdToken();
    await idbPut('authCache', {
      uid:user.uid, idToken, refreshToken:user.refreshToken,
      expiresAt:Date.now()+55*60*1000 // نجدّده قبل الانتهاء الفعلي (ساعة) بخمس دقائق احتياطاً
    }, 'current');
  }catch(e){ console.warn('cacheAuthTokens err', e); }
}

// ─── تُستدعى من الصفحة عند كل كتابة تحدث والاتصال مقطوع — تُسجّل
//     نسخة من الكتابة في IndexedDB وتطلب من النظام تنبيهنا عند عودة
//     الشبكة (Background Sync)؛ إن لم تكن الميزة مدعومة (آيفون/سفاري
//     مثلاً) لا يحدث شيء إضافي، وتبقى مزامنة Firestore المعتادة تعمل
//     عند فتح الصفحة كما كانت دائماً ───
async function queueOfflineWrite(docPath, dataObj){
  try{
    const id='w_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);
    await idbPut('pendingWrites', {id, docPath, dataObj, queuedAt:Date.now()});
    if('serviceWorker' in navigator && 'SyncManager' in window){
      const reg=await navigator.serviceWorker.ready;
      await reg.sync.register(SYNC_TAG);
    }
  }catch(e){ console.warn('queueOfflineWrite err', e); }
}

// ─── تُستخدم من داخل الـ Service Worker فقط: تُعيد رمز دخول صالحاً،
//     وتُجدّده عبر REST (باستخدام رمز التجديد المخزَّن) إن كان منتهياً ───
async function getFreshIdToken(){
  const cache=await idbGet('authCache','current');
  if(!cache) return null;
  if(cache.expiresAt>Date.now()) return cache.idToken;
  const res=await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIRESTORE_API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:`grant_type=refresh_token&refresh_token=${encodeURIComponent(cache.refreshToken)}`
  });
  if(!res.ok) return null;
  const d=await res.json();
  await idbPut('authCache', {uid:cache.uid, idToken:d.id_token, refreshToken:d.refresh_token, expiresAt:Date.now()+55*60*1000}, 'current');
  return d.id_token;
}

// ─── تُستخدم من داخل الـ Service Worker فقط: ترسل كل الكتابات
//     المعلّقة فعلياً عبر Firestore REST API عند حدث Background Sync ───
async function flushPendingWrites(){
  const items=await idbGetAll('pendingWrites');
  if(!items.length) return;
  const idToken=await getFreshIdToken();
  if(!idToken) throw new Error('no-auth-token'); // يجعل النظام يعيد جدولة المحاولة لاحقاً تلقائياً
  for(const item of items){
    try{
      const {fields, maskPaths}=buildRestPatch(item.dataObj);
      if(!maskPaths.length){ await idbDelete('pendingWrites', item.id); continue; }
      const qs=maskPaths.map(p=>'updateMask.fieldPaths='+encodeURIComponent(p)).join('&');
      const url=`https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/(default)/documents/${item.docPath}?${qs}`;
      const res=await fetch(url,{
        method:'PATCH',
        headers:{'Authorization':'Bearer '+idToken,'Content-Type':'application/json'},
        body:JSON.stringify({fields})
      });
      if(res.ok){
        await idbDelete('pendingWrites', item.id);
      }else if(res.status>=400 && res.status<500){
        // خطأ دائم (صلاحيات/بيانات غير صالحة) — لا فائدة من إعادة المحاولة لاحقاً
        console.warn('flushPendingWrites — permanent error', res.status, item.docPath);
        await idbDelete('pendingWrites', item.id);
      }else{
        throw new Error('server-error-'+res.status); // خطأ مؤقت — نترك العنصر ليُعاد لاحقاً
      }
    }catch(e){
      console.warn('flushPendingWrites item err', e);
      throw e; // يجعل Background Sync يُعيد جدولة المحاولة تلقائياً لاحقاً
    }
  }
}
